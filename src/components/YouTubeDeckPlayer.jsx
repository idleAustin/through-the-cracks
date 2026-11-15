// Singleton square-cornered 16:9 YouTube IFrame API deck player with state telemetry and blocked-embed recovery.
import React, { useEffect, useRef, useState } from 'react';
import { isValidVideoId } from '../utils/playlist-helpers';
import Icon from './Icon';

let ytIframeApiPromise = null;

function loadYouTubeIframeApi() {
  if (typeof window === 'undefined') {
    return Promise.reject(new Error('YouTube IFrame API requires a browser window.'));
  }
  if (window.YT?.Player) return Promise.resolve(window.YT);
  if (ytIframeApiPromise) return ytIframeApiPromise;

  ytIframeApiPromise = new Promise((resolve, reject) => {
    const previousReady = window.onYouTubeIframeAPIReady;
    window.onYouTubeIframeAPIReady = () => {
      if (typeof previousReady === 'function') {
        try {
          previousReady();
        } catch {
          // Ignore external callback errors.
        }
      }
      resolve(window.YT);
    };

    const existing = document.querySelector('script[src="https://www.youtube.com/iframe_api"]');
    const onError = () => {
      ytIframeApiPromise = null;
      reject(new Error('Failed to load YouTube IFrame API.'));
    };
    if (!existing) {
      const script = document.createElement('script');
      script.src = 'https://www.youtube.com/iframe_api';
      script.async = true;
      script.onerror = onError;
      document.head.appendChild(script);
    } else {
      existing.addEventListener('error', onError, { once: true });
    }
  });

  return ytIframeApiPromise;
}

export default function YouTubeDeckPlayer({
  videoId,
  autoplay = false,
  controlRef = null,
  onEnded,
  onStatusChange,
  className = '',
  title = 'Broadcast Deck player',
}) {
  const hostRef = useRef(null);
  const playerRef = useRef(null);
  const readyRef = useRef(false);
  const loadedVideoIdRef = useRef('');
  const prevAutoplayRef = useRef(autoplay);

  const cleanVideoId = typeof videoId === 'string' ? videoId.trim() : '';
  const hasValidVideoId = isValidVideoId(cleanVideoId);

  const onEndedRef = useRef(onEnded);
  const onStatusChangeRef = useRef(onStatusChange);
  const videoIdRef = useRef(cleanVideoId);
  const autoplayRef = useRef(autoplay);
  const titleRef = useRef(title);

  onEndedRef.current = onEnded;
  onStatusChangeRef.current = onStatusChange;
  videoIdRef.current = cleanVideoId;
  autoplayRef.current = autoplay;
  titleRef.current = title;

  const [embedBlocked, setEmbedBlocked] = useState(false);

  useEffect(() => {
    if (!controlRef) return undefined;
    controlRef.current = {
      play: () => {
        if (readyRef.current && typeof playerRef.current?.playVideo === 'function') {
          prevAutoplayRef.current = true;
          onStatusChangeRef.current?.('buffering');
          playerRef.current.playVideo();
        } else if (readyRef.current && playerRef.current) {
          onStatusChangeRef.current?.('buffering');
        }
      },
      pause: () => {
        if (readyRef.current && typeof playerRef.current?.pauseVideo === 'function') {
          playerRef.current.pauseVideo();
          onStatusChangeRef.current?.('paused');
        } else if (readyRef.current && playerRef.current) {
          onStatusChangeRef.current?.('paused');
        }
      },
    };
    return () => {
      controlRef.current = null;
    };
  }, [controlRef]);

  useEffect(() => {
    let cancelled = false;
    const host = hostRef.current;
    if (!host) return undefined;

    if (!hasValidVideoId) {
      readyRef.current = false;
      loadedVideoIdRef.current = '';
      host.replaceChildren();
      onStatusChangeRef.current?.('blocked');
      return undefined;
    }

    const mountNode = document.createElement('div');
    host.replaceChildren(mountNode);

    loadYouTubeIframeApi()
      .then((YT) => {
        const initialId = videoIdRef.current;
        if (cancelled || !YT?.Player) return;
        if (!isValidVideoId(initialId)) {
          onStatusChangeRef.current?.('blocked');
          return;
        }
        const initialAutoplay = Boolean(autoplayRef.current);
        loadedVideoIdRef.current = initialId;

        let playerInstance = null;
        playerInstance = new YT.Player(mountNode, {
          videoId: initialId,
          playerVars: {
            rel: 0,
            modestbranding: 1,
            playsinline: 1,
            enablejsapi: 1,
            ...(typeof window !== 'undefined' && window.location?.origin
              ? { origin: window.location.origin }
              : {}),
            autoplay: initialAutoplay ? 1 : 0,
          },
          events: {
            onReady: (event) => {
              if (cancelled) return;
              readyRef.current = true;
              const activePlayer = playerInstance || event?.target || playerRef.current;
              if (activePlayer) playerRef.current = activePlayer;

              try {
                const iframe = typeof activePlayer?.getIframe === 'function' ? activePlayer.getIframe() : null;
                if (iframe && titleRef.current) iframe.setAttribute('title', titleRef.current);
              } catch {
                // Ignore cross-origin iframe attribute errors.
              }

              const latestId = videoIdRef.current;
              if (!isValidVideoId(latestId)) {
                onStatusChangeRef.current?.('blocked');
                return;
              }
              const latestAutoplay = Boolean(autoplayRef.current);
              if (latestId !== loadedVideoIdRef.current && activePlayer) {
                loadedVideoIdRef.current = latestId;
                setEmbedBlocked(false);
                onStatusChangeRef.current?.(latestAutoplay ? 'buffering' : 'cued');
                if (latestAutoplay) activePlayer.loadVideoById(latestId);
                else activePlayer.cueVideoById(latestId);
              } else if (latestAutoplay && !initialAutoplay && typeof activePlayer?.playVideo === 'function') {
                setEmbedBlocked(false);
                onStatusChangeRef.current?.('buffering');
                activePlayer.playVideo();
              } else {
                onStatusChangeRef.current?.(initialAutoplay ? 'buffering' : 'cued');
              }
            },
            onStateChange: (event) => {
              if (cancelled) return;
              const states = YT.PlayerState || {};
              const code = event?.data;
              if (code === (states.ENDED ?? 0)) {
                onStatusChangeRef.current?.('ended');
                onEndedRef.current?.();
              } else if (code === (states.PLAYING ?? 1)) {
                setEmbedBlocked(false);
                onStatusChangeRef.current?.('playing');
              } else if (code === (states.PAUSED ?? 2)) {
                onStatusChangeRef.current?.('paused');
              } else if (code === (states.BUFFERING ?? 3)) {
                onStatusChangeRef.current?.('buffering');
              } else if (code === (states.CUED ?? 5)) {
                onStatusChangeRef.current?.('cued');
              }
            },
            onError: () => {
              if (cancelled) return;
              setEmbedBlocked(true);
              onStatusChangeRef.current?.('blocked');
            },
          },
        });
        playerRef.current = playerInstance;
      })
      .catch(() => {
        if (cancelled) return;
        setEmbedBlocked(true);
        onStatusChangeRef.current?.('blocked');
      });

    return () => {
      cancelled = true;
      readyRef.current = false;
      loadedVideoIdRef.current = '';
      const player = playerRef.current;
      playerRef.current = null;
      if (player && typeof player.destroy === 'function') {
        try {
          player.destroy();
        } catch {
          // Ignore teardown errors on detached containers.
        }
      }
      host.replaceChildren();
    };
  }, [hasValidVideoId]);

  useEffect(() => {
    const prevAutoplay = prevAutoplayRef.current;
    prevAutoplayRef.current = autoplay;
    setEmbedBlocked(false);

    if (!hasValidVideoId) {
      onStatusChangeRef.current?.('blocked');
      return;
    }

    const player = playerRef.current;
    if (!player || !readyRef.current) return;

    try {
      const iframe = typeof player.getIframe === 'function' ? player.getIframe() : null;
      if (iframe && title) iframe.setAttribute('title', title);

      if (loadedVideoIdRef.current === cleanVideoId) {
        if (autoplay && !prevAutoplay && typeof player.playVideo === 'function') {
          onStatusChangeRef.current?.('buffering');
          player.playVideo();
        }
        return;
      }

      loadedVideoIdRef.current = cleanVideoId;
      if (autoplay) {
        onStatusChangeRef.current?.('buffering');
        player.loadVideoById(cleanVideoId);
      } else {
        onStatusChangeRef.current?.('cued');
        player.cueVideoById(cleanVideoId);
      }
    } catch {
      setEmbedBlocked(true);
      onStatusChangeRef.current?.('blocked');
    }
  }, [cleanVideoId, hasValidVideoId, autoplay, title]);

  const isBlocked = !hasValidVideoId || embedBlocked;

  return (
    <div className={`yt-deck-frame${isBlocked ? ' is-blocked' : ''} ${className}`.trim()}>
      <div ref={hostRef} className="yt-deck-host" />
      {isBlocked ? (
        <div className="yt-deck-blocked" role="alert">
          <p className="yt-deck-blocked-copy">
            {hasValidVideoId
              ? 'Blocked in embedded player. Swap song or open directly on YouTube.'
              : 'Video unavailable. Swap song to cue another.'}
          </p>
          {hasValidVideoId ? (
            <a
              className="btn btn-secondary btn-sm"
              href={`https://www.youtube.com/watch?v=${encodeURIComponent(cleanVideoId)}`}
              target="_blank"
              rel="noopener noreferrer"
            >
              <Icon name="external" size="sm" />
              <span>Open on YouTube</span>
            </a>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
