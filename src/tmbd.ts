import type {
  MediaType,
  Region,
  StreamingProvider,
  TvDetails,
  TmdbSearchResult
} from "./types";

const API_KEY = import.meta.env.VITE_TMDB_API_KEY?.trim();
const API_BASE = "https://api.themoviedb.org/3";

export const tmdbConfigured = Boolean(API_KEY);

async function apiGet<T>(
  path: string,
  params: Record<string, string> = {},
  signal?: AbortSignal
): Promise<T> {
  if (!API_KEY) {
    throw new Error("Der TMDb API-Key ist noch nicht konfiguriert.");
  }

  const url = new URL(`${API_BASE}${path}`);
  url.searchParams.set("api_key", API_KEY);
  url.searchParams.set("language", "de-DE");

  Object.entries(params).forEach(([key, value]) => {
    url.searchParams.set(key, value);
  });

  const response = await fetch(url, { signal });

  if (!response.ok) {
    const body = (await response.json().catch(() => null)) as
      | { status_message?: string }
      | null;

    throw new Error(
      body?.status_message ?? `TMDb-Anfrage fehlgeschlagen (${response.status}).`
    );
  }

  return (await response.json()) as T;
}

export async function searchMulti(
  query: string,
  signal?: AbortSignal
): Promise<TmdbSearchResult[]> {
  const data = await apiGet<{ results: TmdbSearchResult[] }>(
    "/search/multi",
    {
      query,
      include_adult: "false"
    },
    signal
  );

  return (data.results ?? []).filter(
    (item) =>
      (item.media_type === "movie" || item.media_type === "tv") &&
      item.adult !== true
  );
}

export async function getWatchProviders(
  mediaType: MediaType,
  id: number,
  region: Region,
  signal?: AbortSignal
): Promise<StreamingProvider[]> {
  type ProviderResponse = {
    results?: Record<
      string,
      {
        flatrate?: StreamingProvider[];
        free?: StreamingProvider[];
      }
    >;
  };

  const data = await apiGet<ProviderResponse>(
    `/${mediaType}/${id}/watch/providers`,
    {},
    signal
  );

  const country = data.results?.[region];
  const providers = [...(country?.flatrate ?? []), ...(country?.free ?? [])];

  return Array.from(
    new Map(providers.map((provider) => [provider.provider_id, provider])).values()
  );
}

export async function getAgeRating(
  mediaType: MediaType,
  id: number,
  region: Region,
  signal?: AbortSignal
): Promise<string | null> {
  if (mediaType === "movie") {
    type MovieRatings = {
      results?: Array<{
        iso_3166_1: string;
        release_dates?: Array<{ certification?: string }>;
      }>;
    };

    const data = await apiGet<MovieRatings>(
      `/movie/${id}/release_dates`,
      {},
      signal
    );

    const country = data.results?.find((entry) => entry.iso_3166_1 === region);
    const rating = country?.release_dates
      ?.map((entry) => entry.certification?.trim())
      .find((entry): entry is string => Boolean(entry));

    return rating ?? null;
  }

  type TvRatings = {
    results?: Array<{
      iso_3166_1: string;
      rating?: string;
    }>;
  };

  const data = await apiGet<TvRatings>(
    `/tv/${id}/content_ratings`,
    {},
    signal
  );

  return (
    data.results
      ?.find((entry) => entry.iso_3166_1 === region)
      ?.rating?.trim() || null
  );
}

export async function getTvDetails(
  id: number,
  signal?: AbortSignal
): Promise<TvDetails> {
  return apiGet<TvDetails>(`/tv/${id}`, {}, signal);
}

export function imageUrl(
  path: string | null | undefined,
  size = "w342"
): string | null {
  return path ? `https://image.tmdb.org/t/p/${size}${path}` : null;
}

export function providerKeyForName(name: string): string {
  const value = name
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "");

  if (value.includes("netflix")) return "netflix";
  if (value.includes("prime video") || value.includes("amazon prime")) return "prime";
  if (value.includes("disney")) return "disney";
  if (value.includes("wow") || value.includes("sky")) return "wow";
  if (value.includes("apple tv")) return "apple_tv_plus";
  if (value.includes("paramount")) return "paramount_plus";
  if (value.includes("rtl")) return "rtl_plus";
  if (value.includes("joyn")) return "joyn";
  if (value.includes("magenta")) return "magenta_tv";
  if (value.includes("crunchyroll")) return "crunchyroll";

  return value.replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "");
}