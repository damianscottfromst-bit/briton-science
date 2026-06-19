// ===== BRITON SCIENCE — Fonction serverless sécurisée (Cloudflare Pages) =====
// Cette fonction tourne sur le réseau mondial Cloudflare.
// La clé API est cachée dans les variables d'environnement (jamais dans le code).
// Sur Cloudflare Pages, ce fichier répond automatiquement à l'URL /api/claude

// En-têtes CORS pour autoriser les appels depuis le site
const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Content-Type': 'application/json'
};

// Réponse aux requêtes préliminaires (CORS preflight)
export async function onRequestOptions() {
  return new Response('', { status: 200, headers: CORS });
}

// Traitement des requêtes POST
export async function onRequestPost(context) {
  // Récupérer la clé API depuis le coffre-fort Cloudflare
  const API_KEY = context.env.ANTHROPIC_API_KEY;
  if (!API_KEY) {
    return new Response(
      JSON.stringify({ error: 'Clé API non configurée. Ajoutez ANTHROPIC_API_KEY dans les variables Cloudflare.' }),
      { status: 500, headers: CORS }
    );
  }

  try {
    const payload = await context.request.json();

    // Appel sécurisé à l'API Anthropic, avec une nouvelle tentative en cas de surcharge (429/529/503)
    async function callAnthropic() {
      return fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': API_KEY,
          'anthropic-version': '2023-06-01'
        },
        body: JSON.stringify({
          model: payload.model || 'claude-sonnet-4-6',
          max_tokens: payload.max_tokens || 2000,
          system: payload.system || '',
          messages: payload.messages || []
        })
      });
    }

    let response = await callAnthropic();
    // Si l'API est temporairement surchargée, attendre puis réessayer une fois côté serveur
    if (response.status === 429 || response.status === 529 || response.status === 503) {
      await new Promise(r => setTimeout(r, 1500));
      response = await callAnthropic();
      if (response.status === 429 || response.status === 529 || response.status === 503) {
        await new Promise(r => setTimeout(r, 3000));
        response = await callAnthropic();
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

// Bloquer les autres méthodes (GET, etc.)
export async function onRequest(context) {
  if (context.request.method === 'OPTIONS') return onRequestOptions();
  if (context.request.method === 'POST') return onRequestPost(context);
  return new Response(
    JSON.stringify({ error: 'Méthode non autorisée' }),
    { status: 405, headers: CORS }
  );
}
