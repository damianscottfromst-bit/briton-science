// ===== BRITON SCIENCE — Fonction serverless sécurisée (Cloudflare Pages) =====
// Ce fichier doit être placé dans le dossier functions/api/ du dépôt GitHub, sous le nom claude.js
// Il répond à l'URL /api/claude. La clé API reste cachée dans les variables Cloudflare.

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Content-Type': 'application/json'
};

// Seuls ces modèles peuvent être utilisés (empêche l'appel de modèles très chers)
const ALLOWED_MODELS = ['claude-sonnet-4-6', 'claude-sonnet-5-5', 'claude-haiku-5-5'];
const DEFAULT_MODEL = 'claude-sonnet-5-5';
const MAX_TOKENS_LIMIT = 12000;

export async function onRequestOptions() {
  return new Response('', { status: 200, headers: CORS });
}

export async function onRequestPost(context) {
  const API_KEY = context.env.ANTHROPIC_API_KEY;
  if (!API_KEY) {
    return new Response(
      JSON.stringify({ error: 'Clé API non configurée. Ajoutez ANTHROPIC_API_KEY dans les variables Cloudflare.' }),
      { status: 500, headers: CORS }
    );
  }

  try {
    const payload = await context.request.json();
    const model = ALLOWED_MODELS.includes(payload.model) ? payload.model : DEFAULT_MODEL;
    const maxTokens = Math.min(Number(payload.max_tokens) || 2000, MAX_TOKENS_LIMIT);

    const body = {
      model: model,
      max_tokens: maxTokens,
      system: payload.system || '',
      messages: payload.messages || []
    };
    // Les modèles récents « réfléchissent » par défaut, ce qui consomme la longueur de réponse.
    // On coupe cette réflexion préalable pour garder des cours complets et un coût bas.
    if (model === 'claude-haiku-5-5') body.thinking = { type: 'disabled' };
    if (model === 'claude-sonnet-5-5') body.thinking = { type: 'between_tools' };

    async function callAnthropic(b) {
      return fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': API_KEY,
          'anthropic-version': '2023-06-01'
        },
        body: JSON.stringify(b)
      });
    }

    let response = await callAnthropic(body);

    // Si le réglage de réflexion est refusé, réessayer une fois sans ce réglage
    if (response.status === 400 && body.thinking) {
      const errText = await response.clone().text();
      if (/thinking/i.test(errText)) {
        delete body.thinking;
        response = await callAnthropic(body);
      }
    }

    // Service surchargé : attendre puis réessayer (2 fois maximum)
    if ([429, 529, 503].includes(response.status)) {
      await new Promise(r => setTimeout(r, 1500));
      response = await callAnthropic(body);
      if ([429, 529, 503].includes(response.status)) {
        await new Promise(r => setTimeout(r, 3000));
        response = await callAnthropic(body);
      }
    }

    const data = await response.json();
    if (!response.ok) {
      return new Response(
        JSON.stringify({ error: data?.error?.message || 'Erreur API', status: response.status }),
        { status: response.status, headers: CORS }
      );
    }
    return new Response(JSON.stringify(data), { status: 200, headers: CORS });

  } catch (err) {
    return new Response(
      JSON.stringify({ error: 'Erreur serveur : ' + err.message }),
      { status: 500, headers: CORS }
    );
  }
}

export async function onRequest(context) {
  if (context.request.method === 'OPTIONS') return onRequestOptions();
  if (context.request.method === 'POST') return onRequestPost(context);
  return new Response(
    JSON.stringify({ error: 'Méthode non autorisée' }),
    { status: 405, headers: CORS }
  );
}
