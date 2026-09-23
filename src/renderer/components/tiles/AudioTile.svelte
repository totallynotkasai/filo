<script lang="ts">
  import type { AudioTile } from '../../schema/index';
  import { getContext, onDestroy } from 'svelte';
  import { BOARD_SCOPE_KEY, type BoardScope } from '../../lib/boards/boardScope.svelte';
  import { vaultStore } from '../../stores/vault.svelte';
  import { toMediaUrl } from '../../lib/utils/mediaUrl';
  import { reportError } from '../../lib/utils/errorBus';
  import IconButton from '../shared/IconButton.svelte';
  import { historyStore } from '../../stores/history.svelte';
  import { UpdateAttachmentSrcCommand } from '../../commands/index';

  const scope = getContext<BoardScope>(BOARD_SCOPE_KEY);
  const boardStore = scope.board;

  let { tile }: { tile: AudioTile } = $props();

  let mediaRecorder: MediaRecorder | null = null;
  let audioChunks: Blob[] = [];
  let isRecording = $derived(tile.isRecording);
  let audioEl = $state<HTMLAudioElement | null>(null);
  let recordingError = $state<string | null>(null);
  let playbackError = $state<string | null>(null);

  // Custom player state
  let playing = $state(false);
  let currentTime = $state(0);
  let duration = $state(0);
  let volume = $state(1);

  // Pick a Chromium-supported recorder mimeType. MP3 is NOT a MediaRecorder
  // output format — the previous code saved WebM/Opus bytes under a .mp3
  // extension, which the <audio> element then failed to decode.
  function pickRecorderMimeType(): string {
    const candidates = ['audio/webm;codecs=opus', 'audio/webm', 'audio/ogg;codecs=opus', 'audio/mp4'];
    for (const mt of candidates) {
      if (typeof MediaRecorder !== 'undefined' && MediaRecorder.isTypeSupported(mt)) return mt;
    }
    return '';
  }

  function extensionFor(mimeType: string): string {
    const base = (mimeType.split(';')[0] ?? '').trim().toLowerCase();
    if (base === 'audio/webm') return 'webm';
    if (base === 'audio/ogg') return 'ogg';
    if (base === 'audio/mp4') return 'm4a';
    if (base === 'audio/mpeg') return 'mp3';
    return 'webm';
  }

  function formatTime(seconds: number): string {
    if (!isFinite(seconds) || seconds < 0) return '0:00';
    const m = Math.floor(seconds / 60);
    const s = Math.floor(seconds % 60);
    return `${m}:${s.toString().padStart(2, '0')}`;
  }

  function buildRecordingFilename(ext: string): string {
    const now = new Date();
    const dd = String(now.getDate()).padStart(2, '0');
    const mm = String(now.getMonth() + 1).padStart(2, '0');
    const yyyy = now.getFullYear();
    const hh = String(now.getHours()).padStart(2, '0');
    const mi = String(now.getMinutes()).padStart(2, '0');
    const ss = String(now.getSeconds()).padStart(2, '0');
    return `Recording - Date ${dd}-${mm}-${yyyy} ${hh}-${mi}-${ss}.${ext}`;
  }

  async function startRecording() {
    recordingError = null;
    playbackError = null;
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const mimeType = pickRecorderMimeType();
      mediaRecorder = mimeType ? new MediaRecorder(stream, { mimeType }) : new MediaRecorder(stream);
      audioChunks = [];

      mediaRecorder.ondataavailable = (e) => {
        if (e.data.size > 0) audioChunks.push(e.data);
      };

      mediaRecorder.onstop = async () => {
        const actualType = mediaRecorder?.mimeType || mimeType || 'audio/webm';
        const audioBlob = new Blob(audioChunks, { type: actualType });
        const reader = new FileReader();
        reader.readAsDataURL(audioBlob);
        reader.onloadend = async () => {
          const base64data = (reader.result as string).split(',')[1] ?? '';
          const fileName = buildRecordingFilename(extensionFor(actualType));

          try {
            const vaultPath = vaultStore.path;
            const res = await window.filo.invoke('media:save-audio', vaultPath, base64data, fileName);
            if (res.success) {
              boardStore.updateTile(tile.id, {
                src: res.path,
                isRecording: false,
              });
            } else {
              reportError(
                'AudioTile.save',
                res.error ?? null,
                `Failed to save recording "${fileName}"`,
              );
              boardStore.updateTile(tile.id, { isRecording: false });
            }
          } catch (err) {
            reportError(
              'AudioTile.save',
              err,
              `Failed to save recording "${fileName}"`,
            );
            boardStore.updateTile(tile.id, { isRecording: false });
          }
        };

        stream.getTracks().forEach(track => track.stop());
      };

      mediaRecorder.start();
      boardStore.updateTile(tile.id, { isRecording: true });
    } catch (err) {
      // `recordingError` is rendered inline by the tile UI — that's the
      // primary user surface for mic permission / device failures, so we
      // skip the toast path here and only keep a console breadcrumb for
      // unknown error types that surface as the generic message.
      console.error('[AudioTile] Error starting recording:', err);
      const name = err instanceof Error ? err.name : '';
      if (name === 'NotAllowedError' || name === 'PermissionDeniedError') {
        recordingError = 'Microphone access denied. Please allow microphone permissions.';
      } else if (name === 'NotFoundError') {
        recordingError = 'No microphone found.';
      } else {
        recordingError = 'Could not start recording.';
      }
    }
  }

  function stopRecording() {
    if (mediaRecorder && mediaRecorder.state !== 'inactive') {
      mediaRecorder.stop();
    }
  }

  // Monotonic token: a newer play()/load() invalidates older pending ones.
  // Used to suppress the benign AbortError that Chromium throws when src
  // changes mid-play, and to avoid resurrecting an obsolete error state.
  let playToken = 0;
  let lastReportedPlaying = false;

  async function togglePlay() {
    if (!audioEl) return;
    if (!audioEl.paused) {
      audioEl.pause();
      return;
    }
    const myToken = ++playToken;
    try {
      await audioEl.play();
    } catch (err) {
      if (myToken !== playToken) return;
      const name = err instanceof Error ? err.name : '';
      if (name === 'AbortError') return;
      if (name === 'NotAllowedError') {
        playbackError = 'Click play again to start audio.';
      } else {
        playbackError = 'Could not start playback.';
      }
      playing = false;
    }
  }

  function handleTimeUpdate() {
    if (!audioEl) return;
    currentTime = audioEl.currentTime;
    const isPlayingNow = !audioEl.paused;
    playing = isPlayingNow;
    if (isPlayingNow !== lastReportedPlaying) {
      lastReportedPlaying = isPlayingNow;
      boardStore.updateTile(tile.id, { isPlaying: isPlayingNow });
    }
  }

  function handleLoadedMetadata() {
    if (!audioEl) return;
    duration = audioEl.duration;
    playbackError = null;
  }

  function handleEnded() {
    playing = false;
    if (lastReportedPlaying) {
      lastReportedPlaying = false;
      boardStore.updateTile(tile.id, { isPlaying: false });
    }
  }

  function handleAudioError() {
    if (!audioEl) return;
    const err = audioEl.error;
    if (!err) {
      playbackError = 'Audio could not be played.';
      return;
    }
    switch (err.code) {
      case err.MEDIA_ERR_ABORTED: playbackError = 'Playback aborted.'; break;
      case err.MEDIA_ERR_NETWORK: playbackError = 'Network error loading audio.'; break;
      case err.MEDIA_ERR_DECODE: playbackError = 'Audio file is corrupt or in an unsupported format.'; break;
      case err.MEDIA_ERR_SRC_NOT_SUPPORTED: playbackError = 'Audio format not supported by this build.'; break;
      default: playbackError = 'Audio could not be played.';
    }
    playing = false;
  }

  function seekTo(e: MouseEvent) {
    if (!audioEl || !duration) return;
    const target = e.currentTarget as HTMLElement;
    const rect = target.getBoundingClientRect();
    const ratio = (e.clientX - rect.left) / rect.width;
    audioEl.currentTime = ratio * duration;
  }

  function handleSeekKey(e: KeyboardEvent) {
    if (!audioEl || !duration) return;
    const step = e.shiftKey ? 10 : 5;
    let next = audioEl.currentTime;
    switch (e.key) {
      case 'ArrowLeft':
      case 'ArrowDown':
        next = Math.max(0, audioEl.currentTime - step);
        break;
      case 'ArrowRight':
      case 'ArrowUp':
        next = Math.min(duration, audioEl.currentTime + step);
        break;
      case 'Home':
        next = 0;
        break;
      case 'End':
        next = duration;
        break;
      case 'PageDown':
        next = Math.max(0, audioEl.currentTime - duration * 0.1);
        break;
      case 'PageUp':
        next = Math.min(duration, audioEl.currentTime + duration * 0.1);
        break;
      default:
        return;
    }
    e.preventDefault();
    audioEl.currentTime = next;
  }

  function setVolume(e: Event) {
    const val = parseFloat((e.target as HTMLInputElement).value);
    volume = val;
    if (audioEl) audioEl.volume = val;
  }

  function handleRemove() {
    playToken++;
    if (audioEl && !audioEl.paused) audioEl.pause();
    lastReportedPlaying = false;
    historyStore.execute(
      new UpdateAttachmentSrcCommand(
        tile.id,
        {
          kind: 'src-with-playback',
          src: tile.src ?? '',
          isPlaying: tile.isPlaying ?? false,
          isRecording: tile.isRecording ?? false,
        },
        { kind: 'src-with-playback', src: '', isPlaying: false, isRecording: false },
        'Clear audio',
      ),
    );
    playing = false;
    currentTime = 0;
    duration = 0;
  }

  // Vault-relative paths route through the `filo://` protocol; recording
  // results in a vault-relative path too (see startRecording → media:save-audio).
  // Chromium streams the bytes directly with the right Content-Type — no
  // base64 IPC round-trip required.
  let audioSrc = $derived(toMediaUrl(tile.src, vaultStore.path));

  onDestroy(() => {
    if (mediaRecorder && mediaRecorder.state !== 'inactive') {
      mediaRecorder.stop();
      mediaRecorder.stream.getTracks().forEach(t => t.stop());
    }
  });

  let progressPercent = $derived(duration > 0 ? (currentTime / duration) * 100 : 0);
</script>

<div class="audio-tile" class:recording={isRecording}>
  {#if tile.src}
    <!-- Hidden audio element for programmatic control -->
    <audio
      bind:this={audioEl}
      src={audioSrc}
      ontimeupdate={handleTimeUpdate}
      onloadedmetadata={handleLoadedMetadata}
      onended={handleEnded}
      onerror={handleAudioError}
    ></audio>

    <div class="audio-player">
      <div class="player-icon">
        <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
          <path d="M9 18V5l12-2v13"/>
          <circle cx="6" cy="18" r="3"/>
          <circle cx="18" cy="16" r="3"/>
        </svg>
      </div>

      <!-- Play/Pause -->
      <button class="play-btn" onclick={togglePlay} title={playing ? 'Pause' : 'Play'}>
        {#if playing}
          <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
            <rect x="6" y="4" width="4" height="16" rx="1"/>
            <rect x="14" y="4" width="4" height="16" rx="1"/>
          </svg>
        {:else}
          <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
            <polygon points="5 3 19 12 5 21 5 3"/>
          </svg>
        {/if}
      </button>

      <!-- Progress bar -->
      <div class="progress-section">
        <span class="time-label">{formatTime(currentTime)}</span>
        <div
          class="progress-track"
          role="slider"
          tabindex="0"
          aria-label="Playback position"
          aria-valuemin={0}
          aria-valuemax={Number.isFinite(duration) ? duration : 0}
          aria-valuenow={Number.isFinite(currentTime) ? currentTime : 0}
          aria-valuetext={`${formatTime(currentTime)} of ${formatTime(duration)}`}
          onclick={seekTo}
          onkeydown={handleSeekKey}
        >
          <div class="progress-fill" style:transform="scaleX({progressPercent / 100})"></div>
        </div>
        <span class="time-label">{formatTime(duration)}</span>
      </div>

      <!-- Volume -->
      <div class="volume-control">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
          <polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/>
          {#if volume > 0.5}
            <path d="M19.07 4.93a10 10 0 0 1 0 14.14"/>
            <path d="M15.54 8.46a5 5 0 0 1 0 7.07"/>
          {:else if volume > 0}
            <path d="M15.54 8.46a5 5 0 0 1 0 7.07"/>
          {/if}
        </svg>
        <input
          type="range"
          class="volume-slider"
          min="0"
          max="1"
          step="0.05"
          value={volume}
          oninput={setVolume}
        />
      </div>

      {#if playbackError}
        <div class="playback-error" role="alert">{playbackError}</div>
      {/if}

      <!-- Remove -->
      <div class="remove-btn-container">
        <IconButton title="Remove Audio" danger onclick={handleRemove}>
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">
            <polyline points="3 6 5 6 21 6"></polyline>
            <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path>
          </svg>
        </IconButton>
      </div>
    </div>
  {:else}
    <div class="empty-state">
      <div class="mic-icon" class:pulse={isRecording}>
        <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
          <path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z"/>
          <path d="M19 10v2a7 7 0 0 1-14 0v-2"/>
          <line x1="12" y1="19" x2="12" y2="23"/>
          <line x1="8" y1="23" x2="16" y2="23"/>
        </svg>
      </div>
      {#if isRecording}
        <div class="recording-status">Recording...</div>
        <button class="btn btn-danger" onclick={stopRecording}>Stop</button>
      {:else}
        {#if recordingError}
          <div class="recording-error">{recordingError}</div>
        {/if}
        <button class="btn btn-primary" onclick={startRecording}>Record Audio</button>
        <div class="hint">Or drag & drop an audio file</div>
      {/if}
    </div>
  {/if}
</div>

<style>
  .audio-tile {
    position: relative;
    width: 100%;
    height: 100%;
    display: flex;
    flex-direction: column;
    padding: 12px;
    justify-content: center;
    transition: background 0.3s;
  }
  .audio-tile.recording {
    background: rgba(255, 50, 50, 0.05);
  }

  /* Custom player */
  .audio-player {
    display: flex;
    flex-direction: column;
    gap: 10px;
    align-items: center;
  }

  .player-icon {
    color: var(--text-tertiary);
    opacity: 0.6;
  }

  .play-btn {
    width: 40px;
    height: 40px;
    border-radius: 50%;
    background: var(--accent-primary);
    color: white;
    display: flex;
    align-items: center;
    justify-content: center;
    cursor: pointer;
    border: none;
    transition: background-color 0.15s ease, transform 0.1s ease;
    flex-shrink: 0;
  }
  .play-btn:hover {
    background: var(--accent-primary-hover);
    transform: scale(1.05);
  }
  .play-btn:active {
    transform: scale(0.95);
  }

  .progress-section {
    display: flex;
    align-items: center;
    gap: 8px;
    width: 100%;
  }

  .time-label {
    font-size: 10px;
    color: var(--text-tertiary);
    font-variant-numeric: tabular-nums;
    min-width: 30px;
    text-align: center;
    flex-shrink: 0;
  }

  .progress-track {
    flex: 1;
    height: 4px;
    background: var(--ui-border-light);
    border-radius: 2px;
    cursor: pointer;
    position: relative;
    overflow: hidden;
  }
  .progress-track:hover {
    height: 6px;
  }

  .progress-fill {
    width: 100%;
    height: 100%;
    background: var(--accent-primary);
    border-radius: 2px;
    transform-origin: left center;
    transition: transform 0.1s linear;
    will-change: transform;
  }

  .volume-control {
    display: flex;
    align-items: center;
    gap: 6px;
    color: var(--text-tertiary);
  }

  .volume-slider {
    width: 70px;
    height: 3px;
    accent-color: var(--accent-primary);
    cursor: pointer;
  }

  .remove-btn-container {
    position: absolute;
    top: 4px;
    right: 4px;
    opacity: 0;
    transition: opacity 0.15s ease;
  }
  .audio-tile:hover .remove-btn-container {
    opacity: 1;
  }

  /* Empty state */
  .empty-state {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 12px;
  }
  .mic-icon {
    color: var(--text-tertiary);
  }
  .mic-icon.pulse {
    animation: pulse-red 1.5s infinite;
    color: var(--accent-danger);
  }
  @keyframes pulse-red {
    0% { transform: scale(0.95); opacity: 0.8; }
    50% { transform: scale(1.1); opacity: 1; }
    100% { transform: scale(0.95); opacity: 0.8; }
  }
  .recording-status {
    color: var(--accent-danger);
    font-weight: 600;
    font-size: 14px;
    animation: blink 1s infinite;
  }
  @keyframes blink {
    0%, 100% { opacity: 1; }
    50% { opacity: 0.5; }
  }
  .btn {
    padding: 8px 16px;
    border-radius: 6px;
    border: none;
    font-size: 13px;
    font-weight: 500;
    cursor: pointer;
    transition: background-color 0.15s ease;
  }
  .btn-primary {
    background: var(--accent-primary);
    color: var(--text-inverse);
  }
  .btn-primary:hover {
    background: var(--accent-primary-hover);
  }
  .btn-danger {
    background: var(--accent-danger);
    color: white;
  }
  .btn-danger:hover {
    background: #d32f2f;
  }
  .hint {
    font-size: 11px;
    color: var(--text-tertiary);
  }
  .recording-error {
    font-size: 11px;
    color: var(--accent-danger);
    text-align: center;
    max-width: 180px;
  }
  .playback-error {
    font-size: 11px;
    color: var(--accent-danger);
    text-align: center;
    max-width: 220px;
    margin-top: 4px;
  }
</style>
