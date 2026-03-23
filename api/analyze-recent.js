/**
 * analyze-recent.js
 * Handles fetching a batch of recent conversations from Intercom and analyzing them.
 */

const systemPrompt = `You are an expert Quality Assurance analyst for a regulated iGaming (online casino/sports betting) customer support operation. Analyze the support conversation and return ONLY a valid JSON object — no preamble, no explanation, no markdown.

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

async function getOpenAIAnalysis(transcript, metadata, openAIKey) {
  const { conversation_id = 'unknown', player_id = 'unknown', agent_name = 'Unknown', is_bot_handled = false } = metadata;

  const userMessage = `Conversation ID: ${conversation_id}\nPlayer ID: ${player_id}\nAgent: ${agent_name}\nIs Bot Handled: ${is_bot_handled}\n\nTranscript:\n${transcript}`;

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

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const openAIKey = process.env.OPENAI_API_KEY;
  const intercomApiKey = process.env.INTERCOM_API_KEY;

  if (!openAIKey || !intercomApiKey) {
    return res.status(500).json({ error: 'Server misconfiguration: API keys not found' });
  }

  try {
    // 1. Fetch recent conversations from Intercom (last 24h, closed, max 5)
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
      return res.status(200).json({ message: 'No new closed conversations to analyze in the last 24 hours.', analyses: [] });
    }

    // 2. Analyze each conversation
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

        // Extract agent name from first admin part
        const firstAdmin = (convo.conversation_parts?.conversation_parts || [])
          .find(part => part.author?.type === 'admin');
        const agent_name = firstAdmin?.author?.name || 'Unknown';

        const is_bot_handled = convo.teammates?.some(t => t.type === 'bot') ?? false;

        const metadata = {
          conversation_id: convo.id,
          player_id: convo.contacts?.contacts?.[0]?.id || 'unknown',
          agent_name,
          is_bot_handled
        };

        const analysisResult = await getOpenAIAnalysis(transcript, metadata, openAIKey);

        return {
          ...analysisResult,
          conversation_id: convo.id,
          player_id: metadata.player_id,
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

    res.status(200).json({ analyses: results });

  } catch (error) {
    console.error('Live Analysis Error:', error);
    res.status(500).json({ error: `Failed to perform live analysis: ${error.message}` });
  }
}
