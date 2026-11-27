// ===== BRITON SCIENCE — Fonction serverless sécurisée (Cloudflare Pages) =====
// Ce fichier doit être placé dans le dossier functions/api/ du dépôt GitHub, sous le nom claude.js
// Il répond à l'URL /api/claude. La clé API reste cachée dans les variables Cloudflare.
// PROTECTION : seuls les comptes connectés (jeton Supabase valide) dont l'essai ou l'abonnement est actif
// peuvent l'utiliser. Plafond d'appels par jour et par compte si la requête SQL n° 4 est installée.
// LONGUES RÉPONSES : si l'application le demande (stream: true), la réponse est envoyée au fil de l'eau,
// ce qui évite les coupures de connexion pendant les longues corrections.

const SUPABASE_URL = 'https://lkjijcjogbrzduihewjo.supabase.co';
// Clé publique « anon » (déjà visible dans index.html : ce n'est pas un secret)
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImxramlqY2pvZ2JyemR1aWhld2pvIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODMxODgzNDYsImV4cCI6MjA5ODc2NDM0Nn0.s70kFo3ppI4zI1ezns1SLdILoIHK-0TWM40pImmgp1Q';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Content-Type': 'application/json'
};

// Seuls ces modèles peuvent être utilisés (empêche l'appel de modèles très chers)
const ALLOWED_MODELS = ['claude-sonnet-4-6', 'claude-sonnet-5-5', 'claude-haiku-5-5'];
const DEFAULT_MODEL = 'claude-sonnet-5-5';
const MAX_TOKENS_LIMIT = 12000;

// Mêmes limites que l'application (générations par jour)
const TRIAL_DAILY_LIMIT = 4;
const PAID_DAILY_LIMIT = { base: 5, avance: 8, teacher: 15 };
// Une génération peut faire plusieurs appels (suite d'un long corrigé, nouvel essai réseau) : plafond large
const APPELS_PAR_GENERATION = 6;
const MARGE_APPELS = 10;

function repondre(status, obj) {
  return new Response(JSON.stringify(obj), { status, headers: CORS });
}

// 1) Qui appelle ? On vérifie le jeton auprès de Supabase.
async function verifierUtilisateur(request, env) {
  const url = env.SUPABASE_URL || SUPABASE_URL;
  const anon = env.SUPABASE_ANON_KEY || SUPABASE_ANON_KEY;
  const m = (request.headers.get('Authorization') || '').match(/^Bearer\s+(\S+)$/i);
  if (!m) return { refus: repondre(401, { error: '🔒 Connectez-vous à votre compte Briton Science pour utiliser cette fonction.', code: 'NON_CONNECTE' }) };
  const h = { apikey: anon, Authorization: 'Bearer ' + m[1] };
  let ru;
  try { ru = await fetch(url + '/auth/v1/user', { headers: h }); }
  catch (e) { return { refus: repondre(503, { error: 'Service de connexion momentanément indisponible. Réessayez dans un instant.', code: 'AUTH_INDISPONIBLE' }) }; }
  if (ru.status === 401 || ru.status === 403) return { refus: repondre(401, { error: '🔒 Votre session a expiré. Reconnectez-vous puis réessayez.', code: 'SESSION_EXPIREE' }) };
  if (!ru.ok) return { refus: repondre(503, { error: 'Service de connexion momentanément indisponible. Réessayez dans un instant.', code: 'AUTH_INDISPONIBLE' }) };
  const user = await ru.json().catch(() => null);
  if (!user || !user.id) return { refus: repondre(401, { error: '🔒 Votre session a expiré. Reconnectez-vous puis réessayez.', code: 'SESSION_EXPIREE' }) };
  // Profil lu avec le jeton de l'utilisateur : il ne peut lire que le sien
  let profil = null;
  try {
    const rp = await fetch(url + '/rest/v1/profiles?select=*&id=eq.' + encodeURIComponent(user.id), { headers: h });
    if (rp.ok) { const a = await rp.json(); profil = Array.isArray(a) ? (a[0] || null) : null; }
  } catch (e) { /* profil illisible : traité comme un nouveau compte */ }
  return { user, profil, h, url };
}

// 2) Son essai ou son abonnement est-il actif ? (même règle que l'application)
function droits(p) {
  if (!p) return { ok: true, limite: TRIAL_DAILY_LIMIT };          // profil pas encore créé : accès d'essai
  if (p.role === 'admin') return { ok: true, admin: true };
  const maintenant = Date.now();
  if (p.plan && p.plan !== 'free' && p.plan_expires_at && Date.parse(p.plan_expires_at) > maintenant) {
    const limite = p.role === 'teacher' ? PAID_DAILY_LIMIT.teacher
      : (p.niveau === 'primaire' || p.niveau === 'college') ? PAID_DAILY_LIMIT.base : PAID_DAILY_LIMIT.avance;
    return { ok: true, limite };
  }
  if (p.temp_access_expires_at && Date.parse(p.temp_access_expires_at) > maintenant) return { ok: true, limite: TRIAL_DAILY_LIMIT };
  return { ok: false };
}

// 3) Compte l'appel du jour (fonction SQL « compter_appel_api »). null = requête SQL n° 4 pas encore installée.
async function compterAppel(ctx) {
  try {
    const r = await fetch(ctx.url + '/rest/v1/rpc/compter_appel_api', {
      method: 'POST', headers: { ...ctx.h, 'Content-Type': 'application/json' }, body: '{}'
    });
    if (!r.ok) return null;
    const n = parseInt(await r.text(), 10);
    return Number.isFinite(n) ? n : null;
  } catch (e) { return null; }
}

export async function onRequestOptions() {
  return new Response('', { status: 200, headers: CORS });
}

export async function onRequestPost(context) {
  const API_KEY = context.env.ANTHROPIC_API_KEY;
  if (!API_KEY) {
    return repondre(500, { error: 'Clé API non configurée. Ajoutez ANTHROPIC_API_KEY dans les variables Cloudflare.' });
  }

  try {
    // ---- Contrôle d'accès ----
    const ctx = await verifierUtilisateur(context.request, context.env || {});
    if (ctx.refus) return ctx.refus;
    const d = droits(ctx.profil);
    if (!d.ok) {
      return repondre(403, { error: '⏳ Votre essai gratuit ou votre abonnement est terminé. Choisissez une formule pour continuer.', code: 'ACCES_EXPIRE' });
    }
    if (!d.admin) {
      const appels = await compterAppel(ctx);
      const plafond = d.limite * APPELS_PAR_GENERATION + MARGE_APPELS;
      if (appels !== null && appels > plafond) {
        return repondre(403, { error: '📚 Limite d\'utilisation du jour atteinte pour ce compte. Revenez demain.', code: 'PLAFOND_JOUR' });
      }
    }

    // ---- Appel à Claude (inchangé) ----
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
    const auFilDeLEau = payload.stream === true;
    if (auFilDeLEau) body.stream = true;

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

    if (!response.ok) {
      const data = await response.json().catch(() => ({}));
      return repondre(response.status, { error: data?.error?.message || 'Erreur API', status: response.status });
    }
    if (auFilDeLEau) {
      // Les morceaux de texte arrivent dès qu'ils sont écrits : la connexion ne reste jamais silencieuse
      return new Response(response.body, {
        status: 200,
        headers: { ...CORS, 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache, no-transform' }
      });
    }
    const data = await response.json();
    return repondre(200, data);

  } catch (err) {
    return repondre(500, { error: 'Erreur serveur : ' + err.message });
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
