// /api/now-playing.ts
export const config = { runtime: "edge" };

interface TokenJson {
  access_token: string;
  expires_in?: number;
  error?: string;
}

interface SpotifyImage { url: string; height?: number; width?: number; }
interface SpotifyItem {
  id?: string;
  name?: string;
  artists?: Array<{ name?: string }>;
  album?: { name?: string; images?: SpotifyImage[] };
  external_urls?: { spotify?: string };
}
interface SpotifyResp {
  is_playing?: boolean;
  item?: SpotifyItem | null;
  progress_ms?: number;
}

let cachedAccessToken: string | null = null;
let tokenExpiryMs = 0; // epoch ms

async function fetchAccessToken(): Promise<string> {
  const now = Date.now();
  if (cachedAccessToken && now < tokenExpiryMs - 60_000) {
    return cachedAccessToken;
  }

  const clientId = process.env.SPOTIFY_CLIENT_ID;
  const clientSecret = process.env.SPOTIFY_CLIENT_SECRET;
  const refreshToken = process.env.SPOTIFY_REFRESH_TOKEN;

  if (!clientId || !clientSecret || !refreshToken) {
    throw new Error("Missing SPOTIFY_CLIENT_ID / SPOTIFY_CLIENT_SECRET / SPOTIFY_REFRESH_TOKEN env vars");
  }

  // base64 encode clientId:clientSecret — use btoa in edge, Buffer fallback for Node dev
  const basic = typeof btoa === "function"
    ? btoa(`${clientId}:${clientSecret}`)
    : (globalThis as any).Buffer?.from(`${clientId}:${clientSecret}`).toString("base64");

  const tokenResp = await fetch("https://accounts.spotify.com/api/token", {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      "Authorization": `Basic ${basic}`,
    },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: refreshToken,
    }),
  });

  if (!tokenResp.ok) {
    const txt = await tokenResp.text();
    throw new Error(`Failed to fetch access token: ${tokenResp.status} ${txt}`);
  }

  const json = (await tokenResp.json()) as TokenJson;
  if (!json.access_token) throw new Error(`No access_token in response: ${JSON.stringify(json)}`);

  cachedAccessToken = json.access_token;
  const expires = json.expires_in ?? 3600;
  tokenExpiryMs = Date.now() + expires * 1000;
  return cachedAccessToken;
}

export default async function handler(request: Request) {
  try {
    const accessToken = await fetchAccessToken();

    const resp = await fetch("https://api.spotify.com/v1/me/player/currently-playing", {
      headers: { Authorization: `Bearer ${accessToken}` },
    });

    if (resp.status === 204) {
      return new Response(JSON.stringify({ isPlaying: false }), {
        headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
      });
    }

    if (!resp.ok) {
      const txt = await resp.text();
      throw new Error(`Spotify API error: ${resp.status} ${txt}`);
    }

    const data = (await resp.json()) as SpotifyResp;
    const item = data.item ?? null;

    const images = item?.album?.images ?? [];
    // prefer medium ([1]) -> fallback to [0] -> fallback to last
    const albumArt = images[1]?.url ?? images[0]?.url ?? images[images.length - 1]?.url ?? "";

    const artists = item?.artists?.map(a => a.name).filter(Boolean).join(", ") ?? "";

    const payload = {
      isPlaying: Boolean(data.is_playing),
      title: item?.name ?? "",
      artist: artists,
      album: item?.album?.name ?? "",
      albumArt,
      externalUrl: item?.external_urls?.spotify ?? ""
    };

    return new Response(JSON.stringify(payload), {
      headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    return new Response(JSON.stringify({ error: "now_playing_failed", message }), {
      status: 500,
      headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
    });
  }
}
