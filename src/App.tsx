import { useEffect, useState } from "react";
import type { User } from "firebase/auth";
import {
  getRedirectResult,
  GoogleAuthProvider,
  onAuthStateChanged,
  signInWithRedirect,
  signOut
} from "firebase/auth";
import {
  doc,
  runTransaction,
  serverTimestamp
} from "firebase/firestore";
import { auth, db, firebaseConfigured } from "./firebase";
import {
  getAgeRating,
  getTvDetails,
  getWatchProviders,
  imageUrl,
  providerKeyForName,
  searchMulti,
  tmdbConfigured
} from "./tmdb";
import type {
  Region,
  StreamingProvider,
  TmdbSearchResult,
  WatchStatus
} from "./types";

type SaveState =
  | { kind: "saving"; message: string }
  | { kind: "saved"; message: string }
  | { kind: "exists"; message: string }
  | { kind: "error"; message: string };

const REGIONS: Array<{ code: Region; label: string }> = [
  { code: "DE", label: "Deutschland" },
  { code: "AT", label: "Österreich" },
  { code: "CH", label: "Schweiz" }
];

function itemKey(item: TmdbSearchResult): string {
  return `${item.media_type}_${item.id}`;
}

function titleFor(item: TmdbSearchResult): string {
  return item.media_type === "movie"
    ? item.title || "Unbekannter Film"
    : item.name || "Unbekannte Serie";
}

function dateFor(item: TmdbSearchResult): string {
  return item.media_type === "movie"
    ? item.release_date || ""
    : item.first_air_date || "";
}

function yearFor(item: TmdbSearchResult): string {
  return dateFor(item).slice(0, 4) || "Jahr unbekannt";
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Ein unbekannter Fehler ist aufgetreten.";
}

function isAbortError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "name" in error &&
    (error as { name?: string }).name === "AbortError"
  );
}

function ratingLabel(rating: string | null | undefined, region: Region): string {
  if (!rating) return "Freigabe k. A.";
  if (region === "DE" && /^\d+$/.test(rating)) return `FSK ${rating}`;
  return rating;
}

export default function App() {
  const [user, setUser] = useState<User | null>(null);
  const [authReady, setAuthReady] = useState(false);
  const [authError, setAuthError] = useState("");

  const [query, setQuery] = useState("");
  const [items, setItems] = useState<TmdbSearchResult[]>([]);
  const [searchLoading, setSearchLoading] = useState(false);
  const [searchError, setSearchError] = useState("");

  const [region, setRegion] = useState<Region>("DE");
  const [providerMap, setProviderMap] = useState<
    Record<string, StreamingProvider[]>
  >({});
  const [ratingMap, setRatingMap] = useState<Record<string, string | null>>({});
  const [providerLoading, setProviderLoading] = useState<
    Record<string, boolean>
  >({});

  const [saveStates, setSaveStates] = useState<Record<string, SaveState>>({});

  useEffect(() => {
    if (!auth) {
      setAuthReady(true);
      return;
    }

    const authInstance = auth;
    const unsubscribe = onAuthStateChanged(authInstance, (currentUser) => {
      setUser(currentUser);
      setAuthReady(true);
    });

    void getRedirectResult(authInstance).catch((error: unknown) => {
      setAuthError(errorMessage(error));
    });

    return unsubscribe;
  }, []);

  useEffect(() => {
    const term = query.trim();

    if (term.length < 2 || !tmdbConfigured) {
      setItems([]);
      setSearchError("");
      setSearchLoading(false);
      return;
    }

    let active = true;
    const controller = new AbortController();

    setItems([]);
    setSearchError("");
    setSearchLoading(true);

    const timeout = window.setTimeout(() => {
      void searchMulti(term, controller.signal)
        .then((results) => {
          if (active) setItems(results);
        })
        .catch((error: unknown) => {
          if (active && !isAbortError(error)) {
            setSearchError(errorMessage(error));
            setItems([]);
          }
        })
        .finally(() => {
          if (active) setSearchLoading(false);
        });
    }, 300);

    return () => {
      active = false;
      window.clearTimeout(timeout);
      controller.abort();
    };
  }, [query]);

  useEffect(() => {
    const selectedItems = items.slice(0, 10);

    if (selectedItems.length === 0) {
      setProviderMap({});
      setRatingMap({});
      setProviderLoading({});
      return;
    }

    let active = true;
    const controller = new AbortController();

    setProviderMap({});
    setRatingMap({});
    setProviderLoading(
      Object.fromEntries(selectedItems.map((item) => [itemKey(item), true]))
    );

    void Promise.all(
      selectedItems.map(async (item) => {
        const [providers, rating] = await Promise.all([
          getWatchProviders(
            item.media_type,
            item.id,
            region,
            controller.signal
          ).catch(() => []),
          getAgeRating(
            item.media_type,
            item.id,
            region,
            controller.signal
          ).catch(() => null)
        ]);

        return { key: itemKey(item), providers, rating };
      })
    ).then((results) => {
      if (!active) return;

      setProviderMap(
        Object.fromEntries(results.map((result) => [result.key, result.providers]))
      );
      setRatingMap(
        Object.fromEntries(results.map((result) => [result.key, result.rating]))
      );
      setProviderLoading({});
    });

    return () => {
      active = false;
      controller.abort();
    };
  }, [items, region]);

  async function handleGoogleSignIn() {
    if (!auth) return;

    setAuthError("");

    try {
      const provider = new GoogleAuthProvider();
      provider.setCustomParameters({ prompt: "select_account" });
      await signInWithRedirect(auth, provider);
    } catch (error) {
      setAuthError(errorMessage(error));
    }
  }

  async function handleSignOut() {
    if (!auth) return;

    try {
      await signOut(auth);
    } catch (error) {
      setAuthError(errorMessage(error));
    }
  }

  async function addToWatchlist(
    item: TmdbSearchResult,
    status: WatchStatus
  ) {
    if (!user || !db) {
      setAuthError("Melde dich mit Google an, bevor du einen Titel speicherst.");
      return;
    }

    const database = db;
    const uid = user.uid;
    const key = itemKey(item);

    setSaveStates((current) => ({
      ...current,
      [key]: { kind: "saving", message: "Wird in deiner WatchMate-Cloud gespeichert …" }
    }));

    try {
      const providerPromise = providerMap[key]
        ? Promise.resolve(providerMap[key])
        : getWatchProviders(item.media_type, item.id, region).catch(() => []);

      const detailsPromise =
        item.media_type === "tv"
          ? getTvDetails(item.id).catch(() => null)
          : Promise.resolve(null);

      const [providers, tvDetails] = await Promise.all([
        providerPromise,
        detailsPromise
      ]);

      const seasons = (tvDetails?.seasons ?? []).filter(
        (season) => season.season_number > 0
      );

      const seasonEpisodeCount = Object.fromEntries(
        seasons.map((season) => [
          String(season.season_number),
          season.episode_count
        ])
      );

      const providerKeys = Array.from(
        new Set(providers.map((provider) => providerKeyForName(provider.provider_name)))
      );

      const payload = {
        id: item.id,
        mediaType: item.media_type,
        title: titleFor(item),
        posterPath: item.poster_path ?? "",
        backdropPath: item.backdrop_path ?? "",
        overview: item.overview ?? "",
        releaseDate: dateFor(item),
        voteAverage: Number(item.vote_average ?? 0),
        status,
        currentSeason: item.media_type === "tv" ? 1 : 0,
        currentEpisode: item.media_type === "tv" ? 1 : 0,
        totalSeasons:
          item.media_type === "tv"
            ? tvDetails?.number_of_seasons ?? seasons.length
            : 0,
        seasonEpisodeCount: JSON.stringify(seasonEpisodeCount),
        addedAt: Date.now(),
        lastWatchedAt: 0,
        streamingProviders: JSON.stringify(providerKeys),
        source: "mobile_web",
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp()
      };

      const reference = doc(database, "users", uid, "watchlist", key);

      const created = await runTransaction(database, async (transaction) => {
        const existing = await transaction.get(reference);

        if (existing.exists()) return false;

        transaction.set(reference, payload);
        return true;
      });

      if (created) {
        setSaveStates((current) => ({
          ...current,
          [key]: {
            kind: "saved",
            message: "Gespeichert in deiner WatchMate-Cloud."
          }
        }));

        if ("vibrate" in navigator) navigator.vibrate?.(18);
      } else {
        setSaveStates((current) => ({
          ...current,
          [key]: {
            kind: "exists",
            message: "Dieser Titel steht bereits in deiner Watchlist."
          }
        }));
      }
    } catch (error) {
      setSaveStates((current) => ({
        ...current,
        [key]: { kind: "error", message: errorMessage(error) }
      }));
    }
  }

  const trimmedQuery = query.trim();

  return (
    <div className="app-shell">
      <header className="topbar">
        <a className="brand" href="/" aria-label="WatchMate TV Startseite">
          <span className="brand-mark" aria-hidden="true">
            <span />
          </span>
          <span className="brand-copy">
            <strong>WatchMate</strong>
            <small>TV companion</small>
          </span>
        </a>

        <div className="account-area">
          {!firebaseConfigured ? (
            <span className="account-hint">Firebase noch nicht eingerichtet</span>
          ) : !authReady ? (
            <span className="account-hint">Anmeldung wird geprüft …</span>
          ) : user ? (
            <div className="account-user">
              {user.photoURL ? (
                <img src={user.photoURL} alt="" className="avatar" />
              ) : (
                <span className="avatar avatar-fallback">
                  {(user.displayName || user.email || "W").charAt(0).toUpperCase()}
                </span>
              )}
              <span className="account-name">
                {user.displayName || user.email || "Angemeldet"}
              </span>
              <button className="text-button" type="button" onClick={() => void handleSignOut()}>
                Abmelden
              </button>
            </div>
          ) : (
            <button
              className="google-button"
              type="button"
              onClick={() => void handleGoogleSignIn()}
            >
              <span className="google-g" aria-hidden="true">G</span>
              Mit Google anmelden
            </button>
          )}
        </div>
      </header>

      {authError && (
        <div className="alert alert-error" role="alert">
          <span>{authError}</span>
          <button type="button" onClick={() => setAuthError("")} aria-label="Meldung schließen">
            ×
          </button>
        </div>
      )}

      <main>
        <section className="hero">
          <p className="eyebrow">
            <span className="eyebrow-dot" />
            WATCHMATE TV · MOBILE COMPANION
          </p>

          <h1>
            Ein guter Tipp.
            <br />
            <span>Direkt auf deine Liste.</span>
          </h1>

          <p className="hero-description">
            Filme und Serien finden, Anbieter vergleichen und neue Empfehlungen
            für WatchMate speichern.
          </p>

          <label className="search-box">
            <svg viewBox="0 0 24 24" aria-hidden="true">
              <circle cx="11" cy="11" r="7" />
              <path d="m16 16 4.5 4.5" />
            </svg>
            <input
              type="search"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder={
                tmdbConfigured
                  ? "Film oder Serie suchen …"
                  : "Zuerst einen TMDb API-Key einrichten"
              }
              aria-label="Film oder Serie suchen"
              autoComplete="off"
              maxLength={100}
              disabled={!tmdbConfigured}
            />
            {query && (
              <button
                className="clear-search"
                type="button"
                onClick={() => setQuery("")}
                aria-label="Suche leeren"
              >
                ×
              </button>
            )}
          </label>

          <div className="quick-searches">
            <span>Zum Ausprobieren</span>
            {["Dune", "Severance", "Arcane", "Breaking Bad"].map((suggestion) => (
              <button
                key={suggestion}
                type="button"
                onClick={() => setQuery(suggestion)}
                disabled={!tmdbConfigured}
              >
                {suggestion}
              </button>
            ))}
          </div>

          {!tmdbConfigured && (
            <div className="setup-notice">
              <strong>TMDb ist noch nicht konfiguriert.</strong>
              <span>
                Trage <code>VITE_TMDB_API_KEY</code> in deiner{" "}
                <code>.env.local</code> ein und starte Vite neu.
              </span>
            </div>
          )}

          {firebaseConfigured && authReady && !user && (
            <div className="auth-banner">
              <div>
                <strong>Speichern mit deinem Google-Konto</strong>
                <span>
                  Melde dich an, damit die Einträge deinem WatchMate-Konto
                  zugeordnet werden.
                </span>
              </div>
              <button
                className="google-button"
                type="button"
                onClick={() => void handleGoogleSignIn()}
              >
                <span className="google-g" aria-hidden="true">G</span>
                Anmelden
              </button>
            </div>
          )}

          {!firebaseConfigured && (
            <div className="setup-notice">
              <strong>Firebase ist noch nicht konfiguriert.</strong>
              <span>
                Ergänze die Firebase-Werte in <code>.env.local</code>, um
                Einträge speichern zu können.
              </span>
            </div>
          )}
        </section>

        <section className="results-section" aria-live="polite">
          <div className="section-heading">
            <div>
              <p className="section-kicker">DEINE NÄCHSTE EMPFEHLUNG</p>
              <h2>
                {trimmedQuery.length >= 2
                  ? `Ergebnisse für „${trimmedQuery}“`
                  : "Titel entdecken"}
              </h2>
            </div>

            <label className="region-picker">
              <span>Streaming in</span>
              <select
                value={region}
                onChange={(event) => setRegion(event.target.value as Region)}
                aria-label="Region für Streaming-Anbieter"
              >
                {REGIONS.map((entry) => (
                  <option key={entry.code} value={entry.code}>
                    {entry.code}
                  </option>
                ))}
              </select>
            </label>
          </div>

          {searchLoading && (
            <div className="empty-panel">
              <span className="spinner" />
              <span>Suche bei TMDb …</span>
            </div>
          )}

          {!searchLoading && searchError && (
            <div className="empty-panel error-panel">
              <strong>Die Suche ist fehlgeschlagen.</strong>
              <span>{searchError}</span>
            </div>
          )}

          {!searchLoading && !searchError && trimmedQuery.length < 2 && (
            <div className="empty-panel">
              <span className="empty-icon">⌕</span>
              <strong>Wonach suchst du?</strong>
              <span>Gib mindestens zwei Zeichen ein, um TMDb zu durchsuchen.</span>
            </div>
          )}

          {!searchLoading &&
            !searchError &&
            trimmedQuery.length >= 2 &&
            items.length === 0 && (
              <div className="empty-panel">
                <span className="empty-icon">✦</span>
                <strong>Keine Treffer gefunden</strong>
                <span>Versuche einen anderen Titel oder eine andere Schreibweise.</span>
              </div>
            )}

          {!searchLoading && !searchError && items.length > 0 && (
            <div className="results-list">
              {items.slice(0, 10).map((item) => {
                const key = itemKey(item);
                const title = titleFor(item);
                const poster = imageUrl(item.poster_path);
                const providers = providerMap[key] ?? [];
                const saveState = saveStates[key];
                const alreadySaved =
                  saveState?.kind === "saved" || saveState?.kind === "exists";
                const saving = saveState?.kind === "saving";
                const locked = !user || !db;

                return (
                  <article className="result-card" key={key}>
                    <div className="poster">
                      {poster ? (
                        <img src={poster} alt={`Poster: ${title}`} loading="lazy" />
                      ) : (
                        <div className="poster-placeholder">
                          <span>WATCH<br />MATE</span>
                        </div>
                      )}
                    </div>

                    <div className="result-body">
                      <div className="result-topline">
                        <span className="media-type">
                          {item.media_type === "movie" ? "FILM" : "SERIE"}
                        </span>
                        <span className="rating-chip">
                          {ratingLabel(ratingMap[key], region)}
                        </span>
                      </div>

                      <h3>{title}</h3>

                      <div className="metadata-line">
                        <span>{yearFor(item)}</span>
                        {item.vote_average ? (
                          <span className="rating-score">
                            <span aria-hidden="true">★</span>{" "}
                            {item.vote_average.toFixed(1)}
                          </span>
                        ) : null}
                      </div>

                      <p className="overview">
                        {item.overview || "Für diesen Titel ist keine Inhaltsangabe verfügbar."}
                      </p>

                      <div className="providers-block">
                        <span className="field-label">
                          STREAMING · {region}
                        </span>

                        {providerLoading[key] ? (
                          <span className="provider-loading">Anbieter werden geladen …</span>
                        ) : providers.length > 0 ? (
                          <div className="provider-list">
                            {providers.slice(0, 5).map((provider) => {
                              const logo = imageUrl(provider.logo_path, "w92");

                              return (
                                <span className="provider-chip" key={provider.provider_id}>
                                  {logo && (
                                    <img src={logo} alt="" loading="lazy" />
                                  )}
                                  <span>{provider.provider_name}</span>
                                </span>
                              );
                            })}
                            {providers.length > 5 && (
                              <span className="provider-more">
                                +{providers.length - 5}
                              </span>
                            )}
                          </div>
                        ) : (
                          <span className="provider-loading">
                            Keine Flatrate-Daten verfügbar
                          </span>
                        )}
                      </div>

                      <div className="card-actions">
                        <button
                          className="action-button action-secondary"
                          type="button"
                          disabled={locked || saving || alreadySaved}
                          title={locked ? "Melde dich zuerst mit Google an." : undefined}
                          onClick={() => void addToWatchlist(item, "PLAN_TO_WATCH")}
                        >
                          <span aria-hidden="true">＋</span>
                          Auf die Watchlist
                        </button>

                        <button
                          className="action-button action-primary"
                          type="button"
                          disabled={locked || saving || alreadySaved}
                          title={locked ? "Melde dich zuerst mit Google an." : undefined}
                          onClick={() => void addToWatchlist(item, "WATCHING")}
                        >
                          <span aria-hidden="true">▶</span>
                          Jetzt anschauen
                        </button>
                      </div>

                      {saveState && (
                        <p
                          className={`save-feedback ${saveState.kind}`}
                          role={saveState.kind === "error" ? "alert" : "status"}
                        >
                          {saving && <span className="mini-spinner" />}
                          {saveState.message}
                        </p>
                      )}
                    </div>
                  </article>
                );
              })}
            </div>
          )}
        </section>
      </main>

      <footer className="footer">
        <p>
          Metadaten und Bilder von{" "}
          <a href="https://www.themoviedb.org/" target="_blank" rel="noreferrer">
            TMDb
          </a>
          . Dieses Produkt wird von TMDb weder unterstützt noch zertifiziert.
        </p>
        <p className="sync-disclaimer">
          Cloud-Einträge erscheinen auf dem Fernseher, sobald die
          Firestore-Synchronisierung in WatchMate TV eingerichtet ist.
        </p>
      </footer>
    </div>
  );
}