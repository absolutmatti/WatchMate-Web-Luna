export type MediaType = "movie" | "tv";
export type Region = "DE" | "AT" | "CH";
export type WatchStatus = "PLAN_TO_WATCH" | "WATCHING";

export interface TmdbSearchResult {
  id: number;
  media_type: MediaType;
  adult?: boolean;
  title?: string;
  name?: string;
  poster_path?: string | null;
  backdrop_path?: string | null;
  overview?: string;
  release_date?: string;
  first_air_date?: string;
  vote_average?: number;
}

export interface StreamingProvider {
  provider_id: number;
  provider_name: string;
  logo_path: string | null;
}

export interface TvDetails {
  number_of_seasons?: number;
  seasons?: Array<{
    season_number: number;
    episode_count: number;
  }>;
}