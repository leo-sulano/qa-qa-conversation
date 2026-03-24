/**
 * Unified analyze endpoint (local dev version)
 * Handles both single conversation and batch Intercom analysis
 */

const DEFAULT_SYSTEM_PROMPT = `You are an expert Quality Assurance analyst for a regulated iGaming (online casino/sports betting) customer support operation. Analyze the support conversation and return ONLY a valid JSON object — no preamble, no explanation, no markdown.

LANGUAGE HANDLING:
The conversation transcript may be in any of these languages:
Arabic (ar), German (de), Greek (el), English (en), Finnish (fi), French (fr), Italian (it), Norwegian (no), or Portuguese (pt).
Detect the language of the conversation and return it as an ISO 639-1 code in the "language" field.
ALL other output fields (summary, agent_performance_notes, recommended_action, key_quotes, alert_reason, etc.) must be written in English regardless of the conversation language.

SEVERITY (dissatisfaction_severity):
- "Low"      — Minor frustration, issue fully resolved, player tone normalized
- "Medium"   — Clear dissatisfaction, partially resolved or player still uneasy
- "High"     — Strong dissatisfaction, issue unresolved, churn risk
- "Critical" — Legal/regulatory threat, VIP complaint, fraud indicators, inappropriate agent conduct

ISSUE CATEGORY (issue_category — pick exactly one):
"Payment/Withdrawal" | "Game Bug" | "Login/Account" | "Bonus/Promotion" | "Technical Error" | "Slow Response" | "Inappropriate Communication" | "Other"

RESOLUTION STATUS (resolution_status — based on player sentiment at END of conversation, NOT Intercom status):
"Resolved" | "Partially Resolved" | "Unresolved"

AGENT PERFORMANCE SCORE (agent_performance_score):
- If Is Bot Handled is true: set agent_performance_score to null and agent_performance_notes to "N/A — conversation handled by bot"
- 5=Exceptional, 4=Good, 3=Adequate, 2=Below Standard, 1=Poor

ALERT (is_alert_worthy = true) when ANY of:
- Player mentions legal action, regulator, lawyer
- VIP or high-value player dissatisfied
- Agent used inappropriate or discriminatory language
- Fraud indicators present

Return ONLY this JSON — all fields required:
{
  "language": "ISO 639-1 code (ar|de|el|en|fi|fr|it|no|pt)",
  "summary": "1-3 sentence factual summary",
  "dissatisfaction_severity": "Low|Medium|High|Critical",
  "issue_category": "one of the 8 categories",
  "resolution_status": "Resolved|Partially Resolved|Unresolved",
  "key_quotes": "1-2 direct player quotes, comma-separated, or empty string",
  "agent_performance_score": null,
  "agent_performance_notes": "specific observation about agent performance, or N/A — conversation handled by bot",
  "recommended_action": "specific QA action or No action required",
  "is_alert_worthy": false,
  "alert_reason": null
}`;

async function callOpenAI(systemPrompt, userMessage, openAIKey) {
  const response = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${openAIKey}`
    },
    body: JSON.stringify({
      model: 'gpt-4o',
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userMessage }
      ],
      response_format: { type: 'json_object' },
      temperature: 0.3
    })
  });

  const data = await response.json();
  if (!response.ok) throw new Error(data.error?.message || 'OpenAI API error');

  const messageContent = data.choices[0]?.message?.content;
  if (!messageContent) throw new Error('OpenAI returned an empty response.');

  const jsonMatch = messageContent.match(/\{[\s\S]*\}/);
  if (!jsonMatch) throw new Error('Could not find a valid JSON object in the AI response.');

  return JSON.parse(jsonMatch[0]);
}

async function analyzeSingleConversation(req, openAIKey, systemPrompt) {
  const {
    conversation_id = 'unknown',
    player_id = 'unknown',
    agent_name = 'Unknown',
    transcript,
    intercom_link = '',
    is_bot_handled = false,
    messages,
    text,
    intercomId
  } = req.body;

  let contentToAnalyze = transcript;

  if (!contentToAnalyze && intercomId) {
    const intercomApiKey = process.env.INTERCOM_API_KEY;
    if (!intercomApiKey) {
      throw new Error('Server misconfiguration: INTERCOM_API_KEY not found.');
    }

    const intercomRes = await fetch(`https://api.intercom.io/conversations/${intercomId}`, {
      headers: {
        'Authorization': `Bearer ${intercomApiKey}`,
        'Accept': 'application/json',
        'Intercom-Version': '2.9'
      }
    });

    if (!intercomRes.ok) {
      const errorBody = await intercomRes.text();
      console.error('Intercom API Error:', errorBody);
      throw new Error(`Intercom API responded with ${intercomRes.status}`);
    }

    const conversationData = await intercomRes.json();
    if (!conversationData.conversation_parts?.conversation_parts) {
      throw new Error('Invalid conversation format from Intercom.');
    }

    contentToAnalyze = conversationData.conversation_parts.conversation_parts
      .filter(part => part.part_type === 'comment' && part.body)
      .map(part => {
        const author = part.author.type === 'admin' ? 'Agent' : 'User';
        const body = (part.body || '').replace(/<[^>]*>?/gm, '').trim();
        return `${author}: ${body}`;
      })
      .join('\n\n');
  } else if (!contentToAnalyze && Array.isArray(messages) && messages.length > 0) {
    contentToAnalyze = JSON.stringify(messages);
  } else if (!contentToAnalyze && text) {
    contentToAnalyze = text;
  }

  if (!contentToAnalyze || contentToAnalyze.trim().length === 0) {
    throw new Error(`Empty transcript for conversation ${conversation_id}`);
  }

  const MAX_CHARS = 60000;
  const truncated = contentToAnalyze.length > MAX_CHARS
    ? contentToAnalyze.substring(0, MAX_CHARS) + '\n\n[Transcript truncated]'
    : contentToAnalyze;

  const userMessage = `Conversation ID: ${conversation_id}\nPlayer ID: ${player_id}\nAgent: ${agent_name}\nIs Bot Handled: ${is_bot_handled}\n\nTranscript:\n${truncated}`;
  const analysis = await callOpenAI(systemPrompt, userMessage, openAIKey);

  analysis.conversation_id = conversation_id;
  analysis.player_id = player_id;
  analysis.agent_name = agent_name;
  analysis.intercom_link = intercom_link || (intercomId ? `https://app.intercom.com/a/inbox/conversations/${intercomId}` : '');
  analysis.is_bot_handled = is_bot_handled;

  return analysis;
}

async function analyzeIntercomBatch(openAIKey, systemPrompt) {
  const intercomApiKey = process.env.INTERCOM_API_KEY;
  if (!intercomApiKey) {
    throw new Error('Server misconfiguration: INTERCOM_API_KEY not found');
  }

  const twentyFourHoursAgo = Math.floor((Date.now() - 24 * 60 * 60 * 1000) / 1000);
  const searchPayload = {
    query: {
      operator: 'AND',
      value: [
        { field: 'updated_at', operator: '>', value: twentyFourHoursAgo },
        { field: 'state', operator: '=', value: 'closed' }
      ]
    },
    pagination: { per_page: 5 },
    sort: { field: 'updated_at', order: 'descending' }
  };

  const searchRes = await fetch('https://api.intercom.io/conversations/search', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${intercomApiKey}`,
      'Accept': 'application/json',
      'Content-Type': 'application/json',
      'Intercom-Version': '2.9'
    },
    body: JSON.stringify(searchPayload)
  });

  if (!searchRes.ok) throw new Error(`Intercom API responded with ${searchRes.status}`);

  const searchData = await searchRes.json();
  const conversations = searchData.conversations || [];

  if (conversations.length === 0) {
    return [];
  }

  const analysisPromises = conversations.map(async (convo) => {
    try {
      const MAX_CHARS = 60000;
      let transcript = (convo.conversation_parts?.conversation_parts || [])
        .filter(part => part.part_type === 'comment' && part.body)
        .map(part => `${part.author.type === 'admin' ? 'Agent' : 'User'}: ${(part.body || '').replace(/<[^>]*>?/gm, '').trim()}`)
        .join('\n\n');

      if (!transcript) return null;

      if (transcript.length > MAX_CHARS) {
        transcript = transcript.substring(0, MAX_CHARS) + '\n\n[Transcript truncated]';
      }

      const firstAdmin = (convo.conversation_parts?.conversation_parts || [])
        .find(part => part.author?.type === 'admin');
      const agent_name = firstAdmin?.author?.name || 'Unknown';
      const is_bot_handled = convo.teammates?.some(t => t.type === 'bot') ?? false;

      const userMessage = `Conversation ID: ${convo.id}\nPlayer ID: ${convo.contacts?.contacts?.[0]?.id || 'unknown'}\nAgent: ${agent_name}\nIs Bot Handled: ${is_bot_handled}\n\nTranscript:\n${transcript}`;
      const analysisResult = await callOpenAI(systemPrompt, userMessage, openAIKey);

      return {
        ...analysisResult,
        conversation_id: convo.id,
        player_id: convo.contacts?.contacts?.[0]?.id || 'unknown',
        agent_name,
        is_bot_handled,
        intercom_link: `https://app.intercom.com/a/inbox/conversations/${convo.id}`,
        created_at: convo.created_at
      };
    } catch (error) {
      console.error(`Failed to analyze conversation ${convo.id}:`, error);
      return null;
    }
  });

  const results = (await Promise.all(analysisPromises)).filter(Boolean);
  return results;
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const openAIKey = process.env.OPENAI_API_KEY;
  if (!openAIKey) {
    return res.status(500).json({ error: 'Server misconfiguration: OPENAI_API_KEY not found' });
  }

  const { customSystemPrompt, fetchIntercom } = req.body;
  const systemPrompt = customSystemPrompt || DEFAULT_SYSTEM_PROMPT;

  try {
    if (fetchIntercom) {
      // Batch mode: fetch and analyze recent Intercom conversations
      const analyses = await analyzeIntercomBatch(openAIKey, systemPrompt);
      return res.status(200).json({
        message: `Analyzed ${analyses.length} conversations from Intercom`,
        analyses
      });
    } else {
      // Single mode: analyze one conversation
      const analysis = await analyzeSingleConversation(req, openAIKey, systemPrompt);
      return res.status(200).json(analysis);
    }
  } catch (error) {
    console.error('Analysis Error:', error);
    if (error instanceof SyntaxError) {
      return res.status(500).json({ error: 'Failed to parse AI response as JSON.' });
    }
    return res.status(500).json({ error: error.message });
  }
}
