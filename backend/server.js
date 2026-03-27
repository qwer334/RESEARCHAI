/**
 * ResearchAI — Backend Server
 * Node.js + Express
 * Routes: /api/research, /api/news, /api/cite, /api/sentiment
 * Database: Supabase (saved papers, history, news cache, sentiment)
 */

const express    = require('express');
const cors       = require('cors');
const fetch      = require('node-fetch');
const path       = require('path');
const { createClient } = require('@supabase/supabase-js');
require('dotenv').config();

const app  = express();
const PORT = process.env.PORT || 5000;

app.use(cors({ origin: '*' }));
app.use(express.json());

// ── STATIC FILE SERVING (Frontend) ────────────────────────
app.use(express.static(path.join(__dirname, '../frontend/public')));

// ── Supabase ──────────────────────────────────────────────
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

// ── Helpers ───────────────────────────────────────────────
async function callGroq(prompt, model = 'llama-3.3-70b-versatile') {
  const res = await fetch('https://api.groq.com/openai/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${process.env.GROQ_API_KEY}`
    },
    body: JSON.stringify({
      model,
      messages: [{ role: 'user', content: prompt }],
      temperature: 0.35,
      max_tokens: 4096
    })
  });
  if (!res.ok) {
    const e = await res.json();
    throw new Error(e.error?.message || `Groq error ${res.status}`);
  }
  const d = await res.json();
  return d.choices?.[0]?.message?.content || '';
}

async function callGemini(prompt) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${process.env.GEMINI_API_KEY}`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      contents: [{ parts: [{ text: prompt }] }],
      generationConfig: { temperature: 0.35, maxOutputTokens: 4096 }
    })
  });
  if (!res.ok) {
    const e = await res.json();
    throw new Error(e.error?.message || `Gemini error ${res.status}`);
  }
  const d = await res.json();
  return d.candidates?.[0]?.content?.parts?.[0]?.text || '';
}

// ── Health ────────────────────────────────────────────────
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// ── RESEARCH ──────────────────────────────────────────────
app.post('/api/research', async (req, res) => {
  const { topic, domain, timeRange, engine, sessionId } = req.body;
  if (!topic) return res.status(400).json({ error: 'Topic is required.' });

  const prompt = buildResearchPrompt(topic, domain, timeRange);
  const trendPrompt = buildTrendPrompt(topic);

  try {
    let raw = '';
    if (engine === 'groq') {
      raw = await callGroq(prompt);
    } else if (engine === 'gemini') {
      raw = await callGemini(prompt);
    } else {
      // dual: gemini for papers + groq for trends
      try {
        const [g, q] = await Promise.all([
          callGemini(prompt),
          callGroq(trendPrompt)
        ]);
        raw = g + '\n\n===GROQ_TRENDS===\n' + q;
      } catch (err) {
        console.warn('Gemini failed, falling back to Groq:', err.message);
        const [g, q] = await Promise.all([callGroq(prompt), callGroq(trendPrompt)]);
        raw = g + '\n\n===GROQ_TRENDS===\n' + q;
      }
    }

    // Save to history
    if (sessionId) {
      await supabase.from('search_history').insert({
        session_id: sessionId,
        topic,
        domain: domain || 'all',
        engine: engine || 'dual',
        result_snippet: raw.slice(0, 300)
      });
    }

    res.json({ result: raw });
  } catch (e) {
    console.error('Research error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ── NEWS + SENTIMENT ──────────────────────────────────────
app.post('/api/news', async (req, res) => {
  const { topic, lang, sortBy, fromDate, sessionId } = req.body;
  if (!topic) return res.status(400).json({ error: 'Topic is required.' });

  // Check cache (1 hour)
  const cacheKey = `${topic}__${lang}__${sortBy}`;
  const { data: cached } = await supabase
    .from('news_cache')
    .select('*')
    .eq('cache_key', cacheKey)
    .gte('cached_at', new Date(Date.now() - 60 * 60 * 1000).toISOString())
    .single();

  if (cached) {
    return res.json({
      articles: cached.articles,
      digest:   cached.digest,
      sentiment: cached.sentiment,
      fromCache: true
    });
  }

  // Clamp fromDate to max 27 days ago to prevent free-tier NewsAPI errors
  let safeFromDate = fromDate;
  const safeDaysAgo = new Date(Date.now() - 27 * 24 * 60 * 60 * 1000);
  if (!safeFromDate || new Date(safeFromDate) < safeDaysAgo) {
    safeFromDate = safeDaysAgo.toISOString().split('T')[0];
  }

  // Fetch from NewsAPI
  const newsUrl = `https://newsapi.org/v2/everything?q=${encodeURIComponent(topic)}&language=${lang || 'en'}&sortBy=${sortBy || 'publishedAt'}&from=${safeFromDate}&pageSize=15&apiKey=${process.env.NEWS_API_KEY}`;

  let articles = [];
  try {
    const nRes  = await fetch(newsUrl);
    const nData = await nRes.json();
    if (nData.status !== 'ok') throw new Error(nData.message || 'NewsAPI error');
    articles = (nData.articles || []).filter(a => a.title && a.title !== '[Removed]');
  } catch (e) {
    return res.status(500).json({ error: 'NewsAPI: ' + e.message });
  }

  // AI Digest + Sentiment in parallel
  let digest = '', sentiment = null;
  if (articles.length > 0) {
    const headlines = articles.slice(0, 10)
      .map((a, i) => `${i + 1}. ${a.title} (${a.source?.name || 'Unknown'})`)
      .join('\n');

    const digestPrompt = `You are an academic research assistant for University of Southampton professors.
Analyze these recent news headlines about "${topic}" and produce:

1. DIGEST (3-4 sentences, flowing prose, scholarly tone): Identify dominant narrative, tensions/debates, implications for research or policy.

2. SENTIMENT_JSON — respond with this exact JSON block:
{
  "overall": "positive|negative|neutral|mixed",
  "score": <number -100 to +100>,
  "india_angle": "<1 sentence on Indian relevance or 'Not directly applicable'>",
  "world_angle": "<1 sentence on global relevance>",
  "key_themes": ["theme1", "theme2", "theme3"],
  "controversy_level": "low|medium|high",
  "research_opportunity": "<1 sentence on gap/opportunity for academics>"
}

Headlines:
${headlines}

Format your response EXACTLY as:
DIGEST_START
<your digest prose>
DIGEST_END
SENTIMENT_START
<the JSON block>
SENTIMENT_END`;

    try {
      // Use Gemini for digest (with Groq fallback if Gemini limit exceeded)
      let geminiRes;
      try { geminiRes = await callGemini(digestPrompt); }
      catch (err) { console.warn('Gemini digest failed, using Groq:', err.message); geminiRes = await callGroq(digestPrompt); }

      const dMatch = geminiRes.match(/DIGEST_START([\s\S]*?)DIGEST_END/);
      const sMatch = geminiRes.match(/SENTIMENT_START([\s\S]*?)SENTIMENT_END/);

      digest = dMatch ? dMatch[1].trim() : '';
      if (sMatch) {
        try { sentiment = JSON.parse(sMatch[1].trim()); } catch { sentiment = null; }
      }

      // Use Groq for cross-validation sentiment if Gemini didn't give JSON
      if (!sentiment) {
        const groqSentiment = await callGroq(`Analyze the sentiment of news about "${topic}" based on these headlines:\n${headlines}\n\nReturn ONLY valid JSON:\n{"overall":"positive|negative|neutral|mixed","score":<-100 to 100>,"india_angle":"<string>","world_angle":"<string>","key_themes":["t1","t2","t3"],"controversy_level":"low|medium|high","research_opportunity":"<string>"}`);
        try { sentiment = JSON.parse(groqSentiment.replace(/```json|```/g, '').trim()); } catch { sentiment = null; }
      }
    } catch (e) {
      console.error('AI digest error:', e.message);
    }
  }

  // Cache result
  await supabase.from('news_cache').upsert({
    cache_key:  cacheKey,
    topic,
    articles,
    digest,
    sentiment,
    cached_at:  new Date().toISOString()
  }, { onConflict: 'cache_key' });

  // Save sentiment to sentiment_results table
  if (sentiment && sessionId) {
    await supabase.from('sentiment_results').insert({
      session_id: sessionId,
      topic,
      sentiment_data: sentiment,
      article_count:  articles.length
    });
  }

  res.json({ articles, digest, sentiment, fromCache: false });
});

// ── CITATION CHECKER ──────────────────────────────────────
app.post('/api/cite', async (req, res) => {
  const { citation } = req.body;
  if (!citation) return res.status(400).json({ error: 'Citation is required.' });

  const prompt = `You are a world-class academic citation expert serving university professors.

Analyze this citation or paper title:
"${citation}"

Provide a thorough analysis:
1. CREDIBILITY — Is this a known/verifiable work? Real journal? Real authors?
2. PAPER SUMMARY — Core contribution in 2 sentences
3. APA 7th Edition Format — Correct formatted citation
4. RED FLAGS — Any concerns, retraction risks, predatory journal signals
5. IMPACT — Citation count estimate, field influence

Be concise, sharp, academically authoritative. Max 200 words.`;

  try {
    // Try Groq first, fallback to Gemini
    let result = '';
    try {
      result = await callGroq(prompt);
    } catch {
      result = await callGemini(prompt);
    }
    res.json({ result });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── SAVED PAPERS (Supabase) ───────────────────────────────
app.post('/api/saved', async (req, res) => {
  const { sessionId, title, source, score } = req.body;
  if (!sessionId || !title) return res.status(400).json({ error: 'sessionId and title required.' });

  // Check duplicate
  const { data: existing } = await supabase.from('saved_papers')
    .select('id').eq('session_id', sessionId).eq('title', title).single();
  if (existing) return res.status(409).json({ error: 'Already saved.' });

  const { data, error } = await supabase.from('saved_papers').insert({
    session_id: sessionId, title, source, score
  }).select().single();

  if (error) return res.status(500).json({ error: error.message });
  res.json({ saved: data });
});

app.get('/api/saved/:sessionId', async (req, res) => {
  const { data, error } = await supabase.from('saved_papers')
    .select('*').eq('session_id', req.params.sessionId).order('saved_at', { ascending: false });
  if (error) return res.status(500).json({ error: error.message });
  res.json({ papers: data || [] });
});

app.delete('/api/saved/:id', async (req, res) => {
  const { error } = await supabase.from('saved_papers').delete().eq('id', req.params.id);
  if (error) return res.status(500).json({ error: error.message });
  res.json({ deleted: true });
});

// ── SAVED LIBRARY SUMMARY ─────────────────────────────────
app.get('/api/summarize-saved/:sessionId', async (req, res) => {
  try {
    const { data: papers, error } = await supabase.from('saved_papers')
      .select('*').eq('session_id', req.params.sessionId);
    if (error) return res.status(500).json({ error: error.message });
    if (!papers || papers.length === 0) return res.json({ summary: '<div style="font-size:.78rem;color:var(--muted)">No papers saved yet.</div>' });

    const paperText = papers.map((p, i) => `${i+1}. Title: ${p.title}\nSource: ${p.source}\nScore: ${p.score}`).join('\n\n');

    const prompt = `You are an expert AI research analyst. The user has saved the following academic papers to their library:
${paperText}

Analyze this library and provide a visually structured HTML report returning ONLY valid HTML that can be injected into a div. Do NOT use markdown code blocks (\`\`\`html) around the HTML, just output raw HTML directly.

Design Requirements:
1. Title: "Library Analysis & Cross-Domain Insights" styled cleanly.
2. Overarching Insights: 2-3 bullet points connecting the themes of these papers.
3. Graphical Output: Use inline HTML/CSS to build a visual horizontal bar chart showing the composition of the library topics or source distribution. Use colors like #1e50a0, #15803d, #d97706. Make it look like a premium dashboard component.
4. What to research next: 1 sentence on the logical next gap to explore.

Keep styling clean, modern, and compatible with generic sans-serif fonts. Use standard HTML tags.`;

    const summaryHtml = await callGroq(prompt);
    res.json({ summary: summaryHtml.replace(/```html|```/g, '').trim() });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// ── HISTORY ───────────────────────────────────────────────
app.get('/api/history/:sessionId', async (req, res) => {
  const { data, error } = await supabase.from('search_history')
    .select('*').eq('session_id', req.params.sessionId)
    .order('searched_at', { ascending: false }).limit(25);
  if (error) return res.status(500).json({ error: error.message });
  res.json({ history: data || [] });
});

app.delete('/api/history/:sessionId', async (req, res) => {
  const { error } = await supabase.from('search_history')
    .delete().eq('session_id', req.params.sessionId);
  if (error) return res.status(500).json({ error: error.message });
  res.json({ cleared: true });
});

// ── SENTIMENT HISTORY ─────────────────────────────────────
app.get('/api/sentiment/:sessionId', async (req, res) => {
  const { data, error } = await supabase.from('sentiment_results')
    .select('*').eq('session_id', req.params.sessionId)
    .order('analyzed_at', { ascending: false }).limit(20);
  if (error) return res.status(500).json({ error: error.message });
  res.json({ results: data || [] });
});

// ── PROMPTS ───────────────────────────────────────────────
function buildResearchPrompt(topic, domain, timeRange) {
  return `You are ResearchAI — a world-class academic research intelligence system serving University of Southampton professors.

Research Topic: "${topic}"
Domain: ${domain || 'All Disciplines'}
Time Range: ${timeRange || 'Last Year'}

Generate a comprehensive academic research brief with exactly 5 highly relevant papers. Use specific methodologies, realistic journal names, precise findings and real citation-style formatting.

OUTPUT FORMAT — follow EXACTLY:

PAPER_1_START
Title: [specific realistic research paper title]
Source: [one of: ArXiv, Nature, Science, NEJM, The Lancet, HBR, Journal of Finance, IMF Working Paper, World Bank Report, Cell, PNAS, JAMA, Econometrica, ACM Digital Library, IEEE Transactions]
Relevance Score: [8, 9, or 10]/10
Why Relevant: [one sharp sentence on why this paper directly addresses "${topic}"]
Key Idea: [two precise sentences on the core contribution]
Key Insights:
• [Specific quantitative or methodological finding with numbers]
• [Second key finding — be specific and concrete]
• [Third finding, implication, or breakthrough]
Methodology: [Specific method — e.g. "Randomized controlled trial across 12 hospitals with n=4,200 patients using transformer-based NLP" — be very concrete]
Why It Matters: [1-2 sentences on practical or scholarly significance for "${topic}"]
Limitations: [One honest specific limitation of this study]
PAPER_1_END

PAPER_2_START
[same structure]
PAPER_2_END

PAPER_3_START
[same structure]
PAPER_3_END

PAPER_4_START
[same structure]
PAPER_4_END

PAPER_5_START
[same structure]
PAPER_5_END

TRENDS_START
Trend 1 Title: [specific trend name]
Trend 1 Body: [2-3 sentences on what is shifting, key drivers, what researchers should watch]
Trend 2 Title: [second specific trend]
Trend 2 Body: [2-3 sentences]
TRENDS_END

Critical rules:
- Use specific numbers, model names, datasets
- Mix sources (no two papers from same journal)
- Each paper = a different angle on "${topic}"
- Relevance scores must be 8, 9, or 10 only`;
}

function buildTrendPrompt(topic) {
  return `As a senior research trend analyst at a top UK university, identify 2 precise emerging trends in "${topic}" for 2024-2025.

Format EXACTLY:
Trend A: [specific trend name]
[2-3 sentences on drivers, data, what to watch]

Trend B: [second specific trend]
[2-3 sentences]`;
}

// ── CATCH-ALL ROUTE (Serve Frontend for non-API requests) ──
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, '../frontend/public/index.html'));
});

app.listen(PORT, () => {
  console.log(`✅ ResearchAI backend running on port ${PORT}`);
});
