// Pulls the latest Instagram numbers for one dashboard and saves them to the `syncs` table.
// Called by the Refresh button. Only signed-in admins who are members of that dashboard can run it.
//
// Secrets (set with `supabase secrets set`):
//   META_ACCESS_TOKEN  a Facebook Page access token for the Page linked to the Instagram account
//   GRAPH_VERSION      optional, defaults to v27.0
// SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are provided by Supabase automatically.

// deno-lint-ignore-file no-explicit-any
import { createClient } from 'npm:@supabase/supabase-js@2';

const GRAPH = 'https://graph.facebook.com/' + (Deno.env.get('GRAPH_VERSION') ?? 'v27.0');
const INSIGHT_METRICS = ['views', 'reach', 'saved', 'shares', 'total_interactions'];
const ALLOWED_ORIGINS = ['https://www.insaanlabs.com', 'https://insaanlabs.com', 'http://localhost:8765'];
const TZ = 'America/Toronto';

Deno.serve(async (req) => {
  const origin = req.headers.get('origin') ?? '';
  const headers = {
    'Access-Control-Allow-Origin': ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0],
    'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Vary': 'Origin',
  };
  const reply = (status: number, body: unknown) =>
    new Response(JSON.stringify(body), { status, headers: { ...headers, 'Content-Type': 'application/json' } });

  if (req.method === 'OPTIONS') return new Response('ok', { headers });
  if (req.method !== 'POST') return reply(405, { ok: false, error: 'Use POST.' });

  const db = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  const jwt = (req.headers.get('Authorization') ?? '').replace(/^Bearer\s+/i, '');
  const { data: userData } = await db.auth.getUser(jwt);
  const email = userData?.user?.email?.toLowerCase();
  if (!email) return reply(401, { ok: false, error: 'Your session has expired. Sign in again.' });

  const body = await req.json().catch(() => ({}));
  const client = String(body.client ?? '');
  const platform = String(body.platform ?? 'instagram');
  if (platform !== 'instagram') return reply(400, { ok: false, error: 'Only Instagram can be refreshed for now.' });

  const [{ data: account }, { data: membership }] = await Promise.all([
    db.from('accounts').select('is_admin').eq('email', email).maybeSingle(),
    db.from('memberships').select('client_id').eq('email', email).eq('client_id', client).maybeSingle(),
  ]);
  if (!account?.is_admin || !membership) {
    return reply(403, { ok: false, error: "You don't have permission to refresh this dashboard." });
  }

  const { data: link } = await db.from('integration_accounts').select('external_id')
    .eq('client_id', client).eq('platform', platform).maybeSingle();
  if (!link) return reply(400, { ok: false, error: 'No Instagram account is linked to this dashboard yet.' });

  const { data: prevRow } = await db.from('syncs').select('record')
    .eq('client_id', client).eq('platform', platform).maybeSingle();
  const previous: any = prevRow?.record ?? {};
  const now = new Date().toISOString();

  let record: any;
  try {
    const token = Deno.env.get('META_ACCESS_TOKEN');
    if (!token) throw new Error('The META_ACCESS_TOKEN secret is not set in Supabase.');
    const snap = await snapshot(link.external_id, token);
    record = { client, platform, ok: true, error: null, lastAttemptAt: now, lastSuccessAt: now, ...snap };
  } catch (err) {
    record = {
      ...previous,
      client,
      platform,
      ok: false,
      error: explain(err),
      lastAttemptAt: now,
      lastSuccessAt: previous.lastSuccessAt ?? null,
    };
  }

  const { error: saveError } = await db.from('syncs')
    .upsert({ client_id: client, platform, record, updated_at: now });
  if (saveError) return reply(500, { ok: false, error: 'Fetched from Instagram but could not save: ' + saveError.message });

  return reply(record.ok ? 200 : 502, record);
});

/* Instagram Graph API (same logic as meta-playground/ig.js) */

class GraphError extends Error {
  graph: any;
  constructor(graph: any) {
    super(graph.message);
    this.graph = graph;
  }
}

function explain(err: any): string {
  const g = err?.graph;
  if (!g) return err?.message ?? String(err);
  if (g.code === 190) return 'The Instagram access token has expired or is invalid. Generate a new Page token (node ig.js page-token) and update the META_ACCESS_TOKEN secret in Supabase.';
  if (g.code === 10 || g.code === 200) return 'The access token is missing a permission. Re-generate it with the permissions listed in meta-playground/.env.example.';
  if (g.code === 4 || g.code === 17 || g.code === 32) return 'Instagram is rate-limiting requests right now. Wait a few minutes and try again.';
  return err.message;
}

async function getJson(url: string | URL) {
  const res = await fetch(url);
  const body = await res.json();
  if (body.error) throw new GraphError(body.error);
  return body;
}

function graph(token: string, path: string, params: Record<string, string> = {}) {
  const url = new URL(GRAPH + path);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  url.searchParams.set('access_token', token);
  return getJson(url);
}

const isPermissionError = (err: any) => err?.graph && (err.graph.code === 10 || err.graph.code === 200);

async function snapshot(igId: string, token: string) {
  const profile = await graph(token, '/' + igId, { fields: 'username,name,followers_count,follows_count,media_count' });
  const { posts, insightsAllowed } = await fetchMedia(token, igId, 50);

  let demographics = null;
  try { demographics = toDashboardDemographics(await fetchDemographics(token, igId)); } catch { demographics = null; }

  let tokenExpiresAt = null;
  try {
    const debug = await graph(token, '/debug_token', { input_token: token });
    const at = debug.data?.expires_at;
    tokenExpiresAt = at ? new Date(at * 1000).toISOString() : null;
  } catch { tokenExpiresAt = null; }

  return {
    account: {
      username: profile.username,
      name: profile.name ?? null,
      followers: profile.followers_count,
      following: profile.follows_count,
      mediaCount: profile.media_count,
    },
    insightsAvailable: insightsAllowed,
    tokenExpiresAt,
    demographics,
    posts: posts.map((p: any) => {
      const i = p.insights ?? {};
      return {
        date: localDate(p.timestamp),
        time: localTime(p.timestamp),
        url: p.permalink,
        title: title(p.caption, 60) || '(no caption)',
        kind: kind(p),
        views: i.views ?? null,
        reach: i.reach ?? null,
        likes: p.like_count ?? null,
        comments: p.comments_count ?? null,
        saves: i.saved ?? null,
        shares: i.shares ?? null,
      };
    }),
  };
}

async function fetchMedia(token: string, igId: string, limit: number) {
  const fields = 'id,caption,media_type,media_product_type,timestamp,permalink,like_count,comments_count';
  const posts: any[] = [];
  let page = await graph(token, '/' + igId + '/media', { fields, limit: String(Math.min(limit, 50)) });
  while (true) {
    posts.push(...page.data);
    if (posts.length >= limit || !page.paging?.next) break;
    page = await getJson(page.paging.next);
  }
  posts.length = Math.min(posts.length, limit);

  let insightsAllowed = true;
  for (const p of posts) {
    p.insights = {};
    if (!insightsAllowed) continue;
    try {
      p.insights = await mediaInsights(token, p.id);
    } catch (err) {
      if (isPermissionError(err)) insightsAllowed = false;
      else throw err;
    }
  }
  return { posts, insightsAllowed };
}

// One unsupported metric fails the whole request, so fall back to one metric at a time.
async function mediaInsights(token: string, mediaId: string) {
  try {
    return parseInsights(await graph(token, '/' + mediaId + '/insights', { metric: INSIGHT_METRICS.join(',') }));
  } catch (err) {
    if (isPermissionError(err)) throw err;
  }
  const result: Record<string, number> = {};
  for (const metric of INSIGHT_METRICS) {
    try {
      Object.assign(result, parseInsights(await graph(token, '/' + mediaId + '/insights', { metric })));
    } catch (err) {
      if (isPermissionError(err)) throw err;
    }
  }
  return result;
}

function parseInsights(res: any) {
  const out: Record<string, number> = {};
  for (const d of res.data ?? []) {
    const value = d.total_value ? d.total_value.value : d.values?.[0]?.value;
    if (value != null) out[d.name] = value;
  }
  return out;
}

async function fetchDemographics(token: string, igId: string) {
  const result: Record<string, { label: string; value: number }[]> = {};
  for (const breakdown of ['age', 'gender', 'city', 'country']) {
    try {
      const res = await graph(token, '/' + igId + '/insights', {
        metric: 'follower_demographics',
        period: 'lifetime',
        metric_type: 'total_value',
        breakdown,
      });
      const rows = res.data?.[0]?.total_value?.breakdowns?.[0]?.results ?? [];
      result[breakdown] = rows
        .map((r: any) => ({ label: r.dimension_values.join(' / '), value: r.value }))
        .sort((a: any, b: any) => b.value - a.value);
    } catch (err) {
      if (isPermissionError(err)) throw err;
    }
  }
  return result;
}

function toDashboardDemographics(raw: Record<string, { label: string; value: number }[]>) {
  const regions = new Intl.DisplayNames(['en'], { type: 'region' });
  const genders: Record<string, string> = { F: 'Women', M: 'Men', U: 'Unspecified' };
  const sum = (rows: { value: number }[]) => rows.reduce((s, r) => s + r.value, 0);
  const out: any = { totals: {} };
  if (raw.age) {
    out.age = raw.age.map((r) => ({ label: r.label.replace('-', '–'), value: r.value }))
      .sort((a, b) => a.label.localeCompare(b.label));
  }
  if (raw.gender) out.gender = raw.gender.map((r) => ({ label: genders[r.label] ?? r.label, value: r.value }));
  if (raw.city) {
    out.totals.cities = sum(raw.city);
    out.cities = raw.city.slice(0, 5).map((r) => ({ label: r.label.split(',')[0], value: r.value }));
  }
  if (raw.country) {
    out.totals.countries = sum(raw.country);
    out.countries = raw.country.slice(0, 5).map((r) => {
      let name = r.label;
      try { name = regions.of(r.label) ?? r.label; } catch { name = r.label; }
      return { label: name, value: r.value };
    });
  }
  return out;
}

function kind(p: any) {
  if (p.media_product_type === 'REELS') return 'Reel';
  if (p.media_type === 'CAROUSEL_ALBUM') return 'Carousel';
  if (p.media_type === 'VIDEO') return 'Video';
  if (p.media_type === 'IMAGE') return 'Photo';
  return p.media_type ?? '?';
}

function localDate(ts: string) {
  return new Date(ts).toLocaleDateString('en-CA', { timeZone: TZ });
}

function localTime(ts: string) {
  return new Date(ts).toLocaleTimeString('en-GB', { timeZone: TZ, hour: '2-digit', minute: '2-digit' });
}

function title(caption: string | undefined, max: number) {
  const line = (caption ?? '').split('\n')[0].trim();
  return line.length > max ? line.slice(0, max - 1) + '…' : line;
}
