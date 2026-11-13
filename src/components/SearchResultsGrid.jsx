// Responsive Artists and Songs/Albums search result sections (desktop tables + mobile card stacks).
import React from 'react';
import { formatInt } from '../utils/format';

export default function SearchResultsGrid({
  query,
  artists,
  songs,
  albums,
  selectedArtist,
  isCompact,
  onSelectArtist,
  onSelectSong,
  onSelectAlbum,
}) {
  return (
    <div className="search-results-grid">
      <section
        id="search-artists-section"
        className="surface-region search-section-card"
        aria-label="Artists results"
      >
        <div className="region-toolbar">
          <h2>Artists</h2>
          <span className="mono">{artists.length} shown</span>
        </div>

        {artists.length === 0 ? (
          <div className="search-guidance">No matching artists for &ldquo;{query}&rdquo;.</div>
        ) : isCompact ? (
          <div className="m-card-stack">
            {artists.map((artist) => (
              <button
                key={artist.name}
                type="button"
                className="m-card"
                aria-label={`${artist.name} ${artist.plays} spins`}
                onClick={() => onSelectArtist(artist.name)}
              >
                <span className="m-card-top">
                  <span className="m-card-title">{artist.name}</span>
                  <span className="m-card-stat font-mono num">{formatInt(artist.plays)} spins</span>
                </span>
                <span className="m-card-meta">
                  <span className="font-mono num">{formatInt(artist.uniqueSongs)}</span> songs · Inspect catalog
                </span>
              </button>
            ))}
          </div>
        ) : (
          <div className="table-container">
            <table id="search-artists-table" className="data-table">
              <thead>
                <tr>
                  <th scope="col">Artist</th>
                  <th scope="col" className="col-num">Songs</th>
                  <th scope="col" className="col-num">Spins</th>
                </tr>
              </thead>
              <tbody>
                {artists.map((artist) => (
                  <tr
                    key={artist.name}
                    className={`is-interactive${selectedArtist === artist.name ? ' is-selected' : ''}`}
                    onClick={() => onSelectArtist(artist.name)}
                  >
                    <td className="col-primary">
                      <button
                        type="button"
                        className="cell-link-btn search-artist-desktop-btn"
                        aria-label={`${artist.name} ${artist.plays} spins`}
                        onClick={(event) => {
                          event.stopPropagation();
                          onSelectArtist(artist.name);
                        }}
                      >
                        {artist.name}
                      </button>
                    </td>
                    <td className="col-num">{formatInt(artist.uniqueSongs)}</td>
                    <td className="col-num">{formatInt(artist.plays)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section
        id="search-songs-section"
        className="surface-region search-section-card"
        aria-label="Songs and albums results"
      >
        <div className="region-toolbar">
          <h2>Songs &amp; Albums</h2>
          <span className="mono">{songs.length + albums.length} shown</span>
        </div>

        {songs.length === 0 && albums.length === 0 ? (
          <div className="search-guidance">No matching songs or albums for &ldquo;{query}&rdquo;.</div>
        ) : isCompact ? (
          <div className="m-card-stack">
            {songs.map((song) => (
              <button
                key={`m-song-${song.artist}-${song.songTitle}`}
                type="button"
                className="m-card"
                onClick={() => onSelectSong(song.songTitle, song.artist)}
              >
                <span className="m-card-top">
                  <span className="m-card-title">{song.songTitle}</span>
                  <span className="m-card-stat font-mono num">{formatInt(song.plays)} spins</span>
                </span>
                <span className="m-card-meta">
                  {song.artist}
                  {song.album ? ` · ${song.album}` : ''}
                </span>
              </button>
            ))}
            {albums.map((item) => (
              <button
                key={`m-album-${item.artist}-${item.album}`}
                type="button"
                className="m-card"
                onClick={() => onSelectAlbum(item.artist, item.album)}
              >
                <span className="m-card-top">
                  <span className="m-card-title">{item.album}</span>
                  <span className="m-card-stat font-mono num">{formatInt(item.plays)} spins</span>
                </span>
                <span className="m-card-meta">Album · {item.artist}</span>
              </button>
            ))}
          </div>
        ) : (
          <div className="table-container">
            <table id="search-songs-table" className="data-table">
              <thead>
                <tr>
                  <th scope="col">Song</th>
                  <th scope="col">Artist</th>
                  <th scope="col">Album</th>
                  <th scope="col" className="col-num">Spins</th>
                </tr>
              </thead>
              <tbody>
                {songs.map((song) => (
                  <tr
                    key={`song-${song.artist}-${song.songTitle}`}
                    className="is-interactive"
                    onClick={() => onSelectSong(song.songTitle, song.artist)}
                  >
                    <td className="col-primary">
                      <button
                        type="button"
                        className="cell-link-btn"
                        onClick={(event) => {
                          event.stopPropagation();
                          onSelectSong(song.songTitle, song.artist);
                        }}
                      >
                        {song.songTitle}
                      </button>
                    </td>
                    <td>
                      <button
                        type="button"
                        className="cell-link-btn"
                        onClick={(event) => {
                          event.stopPropagation();
                          onSelectArtist(song.artist);
                        }}
                      >
                        {song.artist}
                      </button>
                    </td>
                    <td>{song.album || '—'}</td>
                    <td className="col-num">{formatInt(song.plays)}</td>
                  </tr>
                ))}
                {albums.map((item) => (
                  <tr
                    key={`album-${item.artist}-${item.album}`}
                    className="is-interactive"
                    onClick={() => onSelectAlbum(item.artist, item.album)}
                  >
                    <td className="col-primary">
                      <button
                        type="button"
                        className="cell-link-btn"
                        onClick={(event) => {
                          event.stopPropagation();
                          onSelectAlbum(item.artist, item.album);
                        }}
                      >
                        {item.album}
                      </button>
                      <span className="search-row-tag">Album</span>
                    </td>
                    <td>
                      <button
                        type="button"
                        className="cell-link-btn"
                        onClick={(event) => {
                          event.stopPropagation();
                          onSelectArtist(item.artist);
                        }}
                      >
                        {item.artist}
                      </button>
                    </td>
                    <td>{item.album}</td>
                    <td className="col-num">{formatInt(item.plays)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}
