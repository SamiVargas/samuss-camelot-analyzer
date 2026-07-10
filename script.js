import { logoutUser, watchAuthState } from "./connection.js";

const KEY_ANALYSIS_WINDOW_SECONDS = 12;
const BPM_ANALYSIS_SECONDS = 60;
const MIN_BPM = 70;
const MAX_BPM = 190;
const NOTE_NAMES = ["C", "C#", "D", "Eb", "E", "F", "F#", "G", "Ab", "A", "Bb", "B"];
const MAJOR_NOTE_NAMES = ["C", "Db", "D", "Eb", "E", "F", "F#", "G", "Ab", "A", "Bb", "B"];
const MINOR_NOTE_NAMES = ["C", "C#", "D", "Eb", "E", "F", "F#", "G", "Ab", "A", "Bb", "B"];
const MAJOR_PROFILE = [6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88];
const MINOR_PROFILE = [6.33, 2.68, 3.52, 5.38, 2.60, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17];
const MAJOR_SCALE = [1, 0, 1, 0, 1, 1, 0, 1, 0, 1, 0, 1];
const MINOR_SCALE = [1, 0, 1, 1, 0, 1, 0, 1, 1, 0, 1, 0];
const MAJOR_TRIAD = [0, 4, 7];
const MINOR_TRIAD = [0, 3, 7];

const camelotToKey = new Map([
  ["1A", "Ab Minor"], ["2A", "Eb Minor"], ["3A", "Bb Minor"], ["4A", "F Minor"],
  ["5A", "C Minor"], ["6A", "G Minor"], ["7A", "D Minor"], ["8A", "A Minor"],
  ["9A", "E Minor"], ["10A", "B Minor"], ["11A", "F# Minor"], ["12A", "C# Minor"],
  ["1B", "B Major"], ["2B", "F# Major"], ["3B", "Db Major"], ["4B", "Ab Major"],
  ["5B", "Eb Major"], ["6B", "Bb Major"], ["7B", "F Major"], ["8B", "C Major"],
  ["9B", "G Major"], ["10B", "D Major"], ["11B", "A Major"], ["12B", "E Major"]
]);

const keyToCamelot = new Map([...camelotToKey.entries()].map(([camelot, key]) => [normalizeKeyName(key), camelot]));

const state = {
  tracks: [],
  orderedPlaylist: [],
  audioContext: null
};

const elements = {
  dropZone: document.querySelector("#dropZone"),
  fileInput: document.querySelector("#fileInput"),
  selectFilesButton: document.querySelector("#selectFilesButton"),
  analyzeButton: document.querySelector("#analyzeButton"),
  sortButton: document.querySelector("#sortButton"),
  clearButton: document.querySelector("#clearButton"),
  logoutButton: document.querySelector("#logoutButton"),
  downloadPlaylistButton: document.querySelector("#downloadPlaylistButton"),
  downloadRenamedButton: document.querySelector("#downloadRenamedButton"),
  trackList: document.querySelector("#trackList"),
  resultsBody: document.querySelector("#resultsBody"),
  playlistBody: document.querySelector("#playlistBody"),
  totalTracks: document.querySelector("#totalTracks"),
  analyzedTracks: document.querySelector("#analyzedTracks"),
  averageBpm: document.querySelector("#averageBpm"),
  emptyStateTemplate: document.querySelector("#emptyStateTemplate")
};

/**
 * Protege la pantalla principal: si no hay usuario activo vuelve al login.
 */
watchAuthState((user) => {
  if (!user) {
    window.location.href = "login.html";
  }
});

/**
 * Retorna un AudioContext compartido para evitar crear varios motores de audio.
 */
function getAudioContext() {
  if (!state.audioContext) {
    state.audioContext = new AudioContext();
  }

  return state.audioContext;
}

/**
 * Normaliza nombres enharmonicos para consultar la tabla Camelot.
 */
function normalizeKeyName(keyName) {
  return keyName
    .replace("Db", "C#")
    .replace("D#", "Eb")
    .replace("G#", "Ab")
    .replace("A#", "Bb")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Convierte segundos a formato mm:ss.
 */
function formatDuration(seconds) {
  if (!Number.isFinite(seconds) || seconds <= 0) {
    return "--:--";
  }

  const minutes = Math.floor(seconds / 60);
  const remainingSeconds = Math.round(seconds % 60).toString().padStart(2, "0");
  return `${minutes}:${remainingSeconds}`;
}

/**
 * Convierte bytes a megabytes legibles.
 */
function formatFileSize(bytes) {
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

/**
 * Obtiene la extension principal del archivo.
 */
function getFileFormat(fileName) {
  return fileName.split(".").pop().toUpperCase();
}

/**
 * Crea el modelo interno de una cancion cargada localmente.
 */
function createTrackFromFile(file) {
  return {
    id: crypto.randomUUID(),
    file,
    originalName: file.name,
    format: getFileFormat(file.name),
    sizeBytes: file.size,
    duration: 0,
    bpm: null,
    key: null,
    mode: null,
    camelot: null,
    confidence: null,
    progress: 0,
    status: "Pendiente"
  };
}

/**
 * Agrega MP3/WAV validos a la cola sin subirlos a ningun servidor.
 */
function addFiles(fileList) {
  const validFiles = [...fileList].filter((file) => ["MP3", "WAV"].includes(getFileFormat(file.name)));
  state.tracks.push(...validFiles.map(createTrackFromFile));
  renderAll();
}

/**
 * Decodifica el archivo completo y lo convierte a mono para poder analizar distintas partes de la cancion.
 */
async function decodeFullAudio(file) {
  const audioContext = getAudioContext();
  const arrayBuffer = await file.arrayBuffer();
  const audioBuffer = await audioContext.decodeAudioData(arrayBuffer.slice(0));
  const monoSamples = new Float32Array(audioBuffer.length);

  for (let channel = 0; channel < audioBuffer.numberOfChannels; channel += 1) {
    const channelSamples = audioBuffer.getChannelData(channel);
    for (let index = 0; index < audioBuffer.length; index += 1) {
      monoSamples[index] += channelSamples[index] / audioBuffer.numberOfChannels;
    }
  }

  return {
    monoSamples,
    sampleRate: audioBuffer.sampleRate,
    duration: audioBuffer.duration
  };
}

/**
 * Calcula energia RMS para medir golpes y tambien descartar fragmentos casi silenciosos.
 */
function getRms(samples, start, size) {
  let sum = 0;
  const end = Math.min(start + size, samples.length);

  for (let index = start; index < end; index += 1) {
    sum += samples[index] * samples[index];
  }

  return Math.sqrt(sum / Math.max(end - start, 1));
}

/**
 * Extrae una porcion del audio y aplica un fade corto para reducir errores de borde.
 */
function extractWindow(samples, startSample, windowSamples) {
  const endSample = Math.min(startSample + windowSamples, samples.length);
  const window = samples.slice(startSample, endSample);
  const fadeSamples = Math.min(Math.floor(window.length * 0.05), 2048);

  for (let index = 0; index < fadeSamples; index += 1) {
    const gain = index / Math.max(fadeSamples, 1);
    window[index] *= gain;
    window[window.length - 1 - index] *= gain;
  }

  return window;
}

/**
 * Elige varias zonas de la cancion para evitar depender solo de una intro sin armonia clara.
 */
function getKeyAnalysisWindows(samples, sampleRate, duration) {
  const windowSamples = Math.min(samples.length, Math.floor(KEY_ANALYSIS_WINDOW_SECONDS * sampleRate));

  if (duration <= KEY_ANALYSIS_WINDOW_SECONDS + 2) {
    return [samples];
  }

  const positions = [0.08, 0.18, 0.33, 0.5, 0.67, 0.82];
  const windows = positions
    .map((position) => {
      const centerSample = Math.floor(samples.length * position);
      const startSample = Math.max(0, Math.min(centerSample - Math.floor(windowSamples / 2), samples.length - windowSamples));
      return extractWindow(samples, startSample, windowSamples);
    })
    .filter((window) => getRms(window, 0, window.length) > 0.006);

  return windows.length ? windows : [extractWindow(samples, 0, windowSamples)];
}

/**
 * Estima BPM usando picos de energia en hasta el primer minuto de audio.
 */
function estimateBpm(samples, sampleRate) {
  const analysisSamples = samples.subarray(0, Math.min(samples.length, sampleRate * BPM_ANALYSIS_SECONDS));
  const frameSize = 1024;
  const hopSize = 512;
  const envelope = [];

  for (let start = 0; start + frameSize < analysisSamples.length; start += hopSize) {
    envelope.push(getRms(analysisSamples, start, frameSize));
  }

  const averageEnergy = envelope.reduce((sum, value) => sum + value, 0) / Math.max(envelope.length, 1);
  const peaks = [];

  for (let index = 1; index < envelope.length - 1; index += 1) {
    const isLocalPeak = envelope[index] > envelope[index - 1] && envelope[index] > envelope[index + 1];
    const isStrongPeak = envelope[index] > averageEnergy * 1.22;

    if (isLocalPeak && isStrongPeak) {
      peaks.push((index * hopSize) / sampleRate);
    }
  }

  if (peaks.length < 2) {
    return null;
  }

  const intervals = [];
  for (let index = 1; index < peaks.length; index += 1) {
    const interval = peaks[index] - peaks[index - 1];
    if (interval > 0.24 && interval < 1.3) {
      intervals.push(interval);
    }
  }

  if (!intervals.length) {
    return null;
  }

  intervals.sort((a, b) => a - b);
  const medianInterval = intervals[Math.floor(intervals.length / 2)];
  let bpm = Math.round(60 / medianInterval);

  while (bpm < MIN_BPM) bpm *= 2;
  while (bpm > MAX_BPM) bpm = Math.round(bpm / 2);

  return bpm;
}

/**
 * Mide la energia de una frecuencia puntual con Goertzel, util para construir cromagramas sin librerias externas.
 */
function getFrequencyMagnitude(samples, sampleRate, frequency) {
  const stride = Math.max(1, Math.floor(sampleRate / 22050));
  const effectiveSampleRate = sampleRate / stride;
  const totalSteps = Math.floor(samples.length / stride);
  const angularFrequency = (2 * Math.PI * frequency) / effectiveSampleRate;
  const coefficient = 2 * Math.cos(angularFrequency);
  let previous = 0;
  let previous2 = 0;

  for (let stepIndex = 0; stepIndex < totalSteps; stepIndex += 1) {
    const sampleIndex = stepIndex * stride;
    const windowValue = 0.5 - 0.5 * Math.cos((2 * Math.PI * stepIndex) / Math.max(totalSteps - 1, 1));
    const current = samples[sampleIndex] * windowValue + coefficient * previous - previous2;
    previous2 = previous;
    previous = current;
  }

  return Math.sqrt(Math.max(previous2 * previous2 + previous * previous - coefficient * previous * previous2, 0));
}

/**
 * Construye un cromagrama robusto usando fundamentales y armonicos en varias octavas.
 */
function buildChromaVector(samples, sampleRate) {
  const chroma = new Array(12).fill(0);
  const nyquist = sampleRate / 2;

  for (let midi = 36; midi <= 84; midi += 1) {
    const frequency = 440 * 2 ** ((midi - 69) / 12);
    const pitchClass = midi % 12;
    const octaveWeight = midi >= 48 && midi <= 72 ? 1 : 0.72;
    const fundamental = getFrequencyMagnitude(samples, sampleRate, frequency);
    const secondHarmonic = frequency * 2 < nyquist ? getFrequencyMagnitude(samples, sampleRate, frequency * 2) * 0.28 : 0;
    const thirdHarmonic = frequency * 3 < nyquist ? getFrequencyMagnitude(samples, sampleRate, frequency * 3) * 0.12 : 0;
    chroma[pitchClass] += (fundamental + secondHarmonic + thirdHarmonic) * octaveWeight;
  }

  const floor = Math.min(...chroma);
  const whitened = chroma.map((value) => Math.max(value - floor, 0));
  const maxValue = Math.max(...whitened, 1);
  return whitened.map((value) => value / maxValue);
}

/**
 * Rota un arreglo tonal para compararlo contra cualquier tonica.
 */
function rotateProfile(profile, steps) {
  return profile.map((_value, index) => profile[(index - steps + 12) % 12]);
}

/**
 * Calcula una correlacion simple entre cromagrama y perfil tonal.
 */
function correlate(chroma, profile) {
  const chromaMean = chroma.reduce((sum, value) => sum + value, 0) / chroma.length;
  const profileMean = profile.reduce((sum, value) => sum + value, 0) / profile.length;

  return chroma.reduce((sum, value, index) => {
    return sum + (value - chromaMean) * (profile[index] - profileMean);
  }, 0);
}

/**
 * Suma energia de las notas que pertenecen a una escala.
 */
function scoreScaleMembership(chroma, scaleProfile, tonicIndex) {
  const rotatedScale = rotateProfile(scaleProfile, tonicIndex);
  const inScaleEnergy = chroma.reduce((sum, value, index) => sum + value * rotatedScale[index], 0);
  const outScaleEnergy = chroma.reduce((sum, value, index) => sum + value * (1 - rotatedScale[index]), 0);
  return inScaleEnergy - outScaleEnergy * 0.72;
}

/**
 * Evalua tonica, tercera y quinta porque suelen definir mejor el centro tonal.
 */
function scoreTriad(chroma, tonicIndex, mode) {
  const intervals = mode === "Major" ? MAJOR_TRIAD : MINOR_TRIAD;
  const weights = [1.15, 0.95, 1.05];

  return intervals.reduce((sum, interval, index) => {
    return sum + chroma[(tonicIndex + interval) % 12] * weights[index];
  }, 0);
}

/**
 * Puntua cada tonalidad posible combinando perfil Krumhansl, escala y triada.
 */
function scoreKeyCandidate(chroma, tonicIndex, mode) {
  const profile = mode === "Major" ? MAJOR_PROFILE : MINOR_PROFILE;
  const scale = mode === "Major" ? MAJOR_SCALE : MINOR_SCALE;
  const profileScore = correlate(chroma, rotateProfile(profile, tonicIndex));
  const scaleScore = scoreScaleMembership(chroma, scale, tonicIndex);
  const triadScore = scoreTriad(chroma, tonicIndex, mode);

  return profileScore * 0.58 + scaleScore * 0.72 + triadScore * 1.15;
}

/**
 * Detecta la tonalidad de un fragmento y devuelve candidatos ordenados por puntaje.
 */
function detectWindowKeyCandidates(samples, sampleRate) {
  const chroma = buildChromaVector(samples, sampleRate);
  const candidates = [];

  for (let tonicIndex = 0; tonicIndex < 12; tonicIndex += 1) {
    candidates.push({ tonicIndex, mode: "Major", score: scoreKeyCandidate(chroma, tonicIndex, "Major") });
    candidates.push({ tonicIndex, mode: "Minor", score: scoreKeyCandidate(chroma, tonicIndex, "Minor") });
  }

  return candidates.sort((a, b) => b.score - a.score);
}

/**
 * Analiza varias partes de la cancion y decide la tonalidad por votacion ponderada.
 */
function detectMusicalKeyFromFullTrack(samples, sampleRate, duration) {
  const windows = getKeyAnalysisWindows(samples, sampleRate, duration);
  const aggregateScores = new Map();
  const combinedChroma = new Array(12).fill(0);

  windows.forEach((window) => {
    const candidates = detectWindowKeyCandidates(window, sampleRate);
    const best = candidates[0];
    const second = candidates[1];
    const confidence = Math.max(best.score - second.score, 0.15);
    const key = `${best.tonicIndex}-${best.mode}`;
    aggregateScores.set(key, (aggregateScores.get(key) || 0) + best.score + confidence);

    const chroma = buildChromaVector(window, sampleRate);
    chroma.forEach((value, index) => {
      combinedChroma[index] += value;
    });
  });

  const normalizedCombinedChroma = combinedChroma.map((value) => value / Math.max(windows.length, 1));
  const globalCandidates = [];

  for (let tonicIndex = 0; tonicIndex < 12; tonicIndex += 1) {
    globalCandidates.push({ tonicIndex, mode: "Major", score: scoreKeyCandidate(normalizedCombinedChroma, tonicIndex, "Major") });
    globalCandidates.push({ tonicIndex, mode: "Minor", score: scoreKeyCandidate(normalizedCombinedChroma, tonicIndex, "Minor") });
  }

  globalCandidates.forEach((candidate) => {
    const key = `${candidate.tonicIndex}-${candidate.mode}`;
    aggregateScores.set(key, (aggregateScores.get(key) || 0) + candidate.score * 2);
  });

  const ranked = [...aggregateScores.entries()]
    .map(([key, score]) => {
      const [tonicIndex, mode] = key.split("-");
      return { tonicIndex: Number(tonicIndex), mode, score };
    })
    .sort((a, b) => b.score - a.score);

  const bestResult = ranked[0] || { tonicIndex: 0, mode: "Major", score: 0 };
  const secondResult = ranked[1] || { score: bestResult.score };
  const confidence = Math.min(99, Math.max(45, Math.round(55 + (bestResult.score - secondResult.score) * 8)));
  const noteNames = bestResult.mode === "Major" ? MAJOR_NOTE_NAMES : MINOR_NOTE_NAMES;
  const detectedKeyName = `${noteNames[bestResult.tonicIndex]} ${bestResult.mode}`;
  const camelotKey = convertKeyToCamelot(detectedKeyName);

  return {
    keyName: camelotToKey.get(camelotKey) || detectedKeyName,
    mode: bestResult.mode,
    confidence
  };
}

/**
 * Convierte tonalidad musical a clave Camelot.
 */
function convertKeyToCamelot(keyName) {
  return keyToCamelot.get(normalizeKeyName(keyName)) || "--";
}

/**
 * Limpia caracteres conflictivos para nombres de descarga.
 */
function sanitizeFileName(fileName) {
  return fileName
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[<>:"/\\|?*\x00-\x1F]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Descarga una copia local con Camelot agregado al nombre.
 */
function downloadRenamedTrack(track) {
  if (!track.camelot || track.camelot === "--") {
    return;
  }

  const extension = track.originalName.includes(".") ? `.${track.originalName.split(".").pop()}` : "";
  const baseName = track.originalName.replace(/\.[^/.]+$/, "");
  const renamedFileName = sanitizeFileName(`${track.camelot} - ${baseName}${extension}`);
  const url = URL.createObjectURL(track.file);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = renamedFileName;
  anchor.click();
  URL.revokeObjectURL(url);
}

/**
 * Descarga todas las canciones analizadas con su nombre Camelot.
 */
function downloadAllRenamedTracks() {
  state.tracks.filter((track) => track.camelot).forEach(downloadRenamedTrack);
}

/**
 * Ejecuta el analisis completo de una cancion.
 */
async function analyzeTrack(track) {
  track.status = "Decodificando audio completo";
  track.progress = 14;
  renderAll();

  const audioData = await decodeFullAudio(track.file);
  track.duration = audioData.duration;
  track.progress = 34;
  renderAll();

  track.status = "Estimando BPM";
  track.bpm = estimateBpm(audioData.monoSamples, audioData.sampleRate);
  track.progress = 56;
  renderAll();

  track.status = "Analizando tonalidad en varias secciones";
  const keyResult = detectMusicalKeyFromFullTrack(audioData.monoSamples, audioData.sampleRate, audioData.duration);
  track.key = keyResult.keyName;
  track.mode = keyResult.mode;
  track.camelot = convertKeyToCamelot(track.key);
  track.confidence = keyResult.confidence;
  track.progress = 100;
  track.status = `Analizado (${track.confidence}% confianza)`;
  renderAll();
}

/**
 * Analiza canciones pendientes una por una para evitar bloquear demasiado el navegador.
 */
async function analyzeAllTracks() {
  elements.analyzeButton.disabled = true;

  try {
    for (const track of state.tracks) {
      if (!track.camelot) {
        await analyzeTrack(track);
      }
    }
  } finally {
    elements.analyzeButton.disabled = false;
  }
}

/**
 * Divide una clave Camelot en numero y letra.
 */
function parseCamelotKey(camelotKey) {
  const match = /^(\d{1,2})(A|B)$/.exec(camelotKey || "");
  if (!match) {
    return null;
  }

  return {
    number: Number(match[1]),
    letter: match[2]
  };
}

/**
 * Mantiene los numeros Camelot en una rueda circular 1-12.
 */
function normalizeCamelotNumber(number) {
  return ((number - 1 + 12) % 12) + 1;
}

/**
 * Puntua una transicion armonica segun las reglas solicitadas.
 */
function getTransitionScore(fromTrack, toTrack) {
  const from = parseCamelotKey(fromTrack.camelot);
  const to = parseCamelotKey(toTrack.camelot);

  if (!from || !to) {
    return { score: 0, label: "Sin regla Camelot" };
  }

  if (from.number === to.number && from.letter === to.letter) {
    return { score: 100, label: "Mismo Camelot" };
  }

  if (from.number === to.number && from.letter !== to.letter) {
    return { score: 90, label: to.letter === "B" ? "Relative Major" : "Relative Minor" };
  }

  if (from.letter === to.letter && normalizeCamelotNumber(from.number + 1) === to.number) {
    return { score: 80, label: "+1" };
  }

  if (from.letter === to.letter && normalizeCamelotNumber(from.number - 1) === to.number) {
    return { score: 80, label: "-1" };
  }

  if (from.letter === to.letter && normalizeCamelotNumber(from.number + 7) === to.number) {
    return { score: 70, label: "Energy Boost" };
  }

  if (from.letter === to.letter && normalizeCamelotNumber(from.number - 7) === to.number) {
    return { score: 70, label: "Energy Boost" };
  }

  return { score: 10, label: "Transicion libre" };
}

/**
 * Busca la mejor siguiente cancion segun Camelot y cercania de BPM.
 */
function findBestNextTrack(currentTrack, remainingTracks) {
  return remainingTracks
    .map((track) => {
      const transition = getTransitionScore(currentTrack, track);
      const bpmPenalty = currentTrack.bpm && track.bpm ? Math.abs(currentTrack.bpm - track.bpm) * 0.3 : 0;
      return {
        track,
        transition,
        finalScore: transition.score - bpmPenalty
      };
    })
    .sort((a, b) => b.finalScore - a.finalScore)[0];
}

/**
 * Construye la playlist armonica con una estrategia de mejor siguiente cancion.
 */
function sortPlaylistHarmonically() {
  const analyzableTracks = state.tracks.filter((track) => track.camelot && track.camelot !== "--");

  if (!analyzableTracks.length) {
    state.orderedPlaylist = [];
    renderPlaylist();
    return;
  }

  const remainingTracks = [...analyzableTracks].sort((a, b) => (a.bpm || 0) - (b.bpm || 0));
  const orderedPlaylist = [{ track: remainingTracks.shift(), transition: "Inicio" }];

  while (remainingTracks.length) {
    const currentTrack = orderedPlaylist[orderedPlaylist.length - 1].track;
    const bestCandidate = findBestNextTrack(currentTrack, remainingTracks);
    const selectedIndex = remainingTracks.findIndex((track) => track.id === bestCandidate.track.id);
    remainingTracks.splice(selectedIndex, 1);
    orderedPlaylist.push({
      track: bestCandidate.track,
      transition: bestCandidate.transition.label
    });
  }

  state.orderedPlaylist = orderedPlaylist;
  renderPlaylist();
}

/**
 * Descarga la playlist final como CSV.
 */
function downloadPlaylistCsv() {
  if (!state.orderedPlaylist.length) {
    return;
  }

  const header = ["Orden", "Nombre", "BPM", "Camelot", "Tipo de transicion"];
  const rows = state.orderedPlaylist.map((item, index) => [
    index + 1,
    item.track.originalName,
    item.track.bpm || "",
    item.track.camelot,
    item.transition
  ]);

  const csv = [header, ...rows]
    .map((row) => row.map((cell) => `"${String(cell).replaceAll('"', '""')}"`).join(","))
    .join("\n");

  const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = "SaMuSs-Camelot-Playlist.csv";
  anchor.click();
  URL.revokeObjectURL(url);
}

/**
 * Elimina una cancion de todas las secciones.
 */
function removeTrack(trackId) {
  state.tracks = state.tracks.filter((track) => track.id !== trackId);
  state.orderedPlaylist = state.orderedPlaylist.filter((item) => item.track.id !== trackId);
  renderAll();
}

/**
 * Limpia toda la cola actual.
 */
function clearTracks() {
  state.tracks = [];
  state.orderedPlaylist = [];
  renderAll();
}

/**
 * Renderiza las tarjetas de canciones cargadas.
 */
function renderTrackList() {
  elements.trackList.innerHTML = "";

  if (!state.tracks.length) {
    elements.trackList.appendChild(elements.emptyStateTemplate.content.cloneNode(true));
    return;
  }

  state.tracks.forEach((track) => {
    const card = document.createElement("article");
    card.className = "track-card";
    card.innerHTML = `
      <div class="track-card-header">
        <span class="track-name">${track.originalName}</span>
        <button class="remove-button" type="button" aria-label="Eliminar ${track.originalName}">x</button>
      </div>
      <div class="track-meta">
        <span>${formatFileSize(track.sizeBytes)}</span>
        <span>${formatDuration(track.duration)}</span>
        <span>${track.format}</span>
      </div>
      <div class="progress-bar" aria-label="Progreso de analisis">
        <span style="--progress: ${track.progress}%"></span>
      </div>
      <div class="track-result">
        <span>${track.status}</span>
        <span>${track.camelot ? `${track.key} / ${track.camelot}` : "Sin analizar"}</span>
      </div>
    `;

    card.querySelector(".remove-button").addEventListener("click", () => removeTrack(track.id));
    elements.trackList.appendChild(card);
  });
}

/**
 * Renderiza la tabla de analisis.
 */
function renderResultsTable() {
  elements.resultsBody.innerHTML = "";

  state.tracks.forEach((track) => {
    const row = document.createElement("tr");
    row.innerHTML = `
      <td>${track.originalName}</td>
      <td>${track.format}</td>
      <td>${formatDuration(track.duration)}</td>
      <td>${track.bpm ? `${track.bpm} BPM` : "--"}</td>
      <td>${track.key ? `${track.key}${track.confidence ? ` (${track.confidence}%)` : ""}` : "--"}</td>
      <td><span class="camelot-pill">${track.camelot || "--"}</span></td>
    `;
    elements.resultsBody.appendChild(row);
  });
}

/**
 * Renderiza la playlist ordenada.
 */
function renderPlaylist() {
  elements.playlistBody.innerHTML = "";

  state.orderedPlaylist.forEach((item, index) => {
    const row = document.createElement("tr");
    row.innerHTML = `
      <td>${index + 1}</td>
      <td>${item.track.originalName}</td>
      <td>${item.track.bpm ? `${item.track.bpm} BPM` : "--"}</td>
      <td><span class="camelot-pill">${item.track.camelot}</span></td>
      <td>${item.transition}</td>
    `;
    elements.playlistBody.appendChild(row);
  });
}

/**
 * Actualiza contadores laterales.
 */
function renderStats() {
  const analyzedTracks = state.tracks.filter((track) => track.camelot).length;
  const tracksWithBpm = state.tracks.filter((track) => track.bpm);
  const averageBpm = tracksWithBpm.length
    ? Math.round(tracksWithBpm.reduce((sum, track) => sum + track.bpm, 0) / tracksWithBpm.length)
    : "--";

  elements.totalTracks.textContent = state.tracks.length;
  elements.analyzedTracks.textContent = analyzedTracks;
  elements.averageBpm.textContent = averageBpm;
}

/**
 * Renderiza todas las areas dinamicas.
 */
function renderAll() {
  renderTrackList();
  renderResultsTable();
  renderPlaylist();
  renderStats();
}

elements.selectFilesButton.addEventListener("click", () => elements.fileInput.click());
elements.fileInput.addEventListener("change", (event) => addFiles(event.target.files));
elements.analyzeButton.addEventListener("click", analyzeAllTracks);
elements.sortButton.addEventListener("click", sortPlaylistHarmonically);
elements.clearButton.addEventListener("click", clearTracks);
elements.downloadPlaylistButton.addEventListener("click", downloadPlaylistCsv);
elements.downloadRenamedButton.addEventListener("click", downloadAllRenamedTracks);
elements.logoutButton.addEventListener("click", logoutUser);

elements.dropZone.addEventListener("dragover", (event) => {
  event.preventDefault();
  elements.dropZone.classList.add("is-dragging");
});

elements.dropZone.addEventListener("dragleave", () => {
  elements.dropZone.classList.remove("is-dragging");
});

elements.dropZone.addEventListener("drop", (event) => {
  event.preventDefault();
  elements.dropZone.classList.remove("is-dragging");
  addFiles(event.dataTransfer.files);
});

elements.dropZone.addEventListener("keydown", (event) => {
  if (event.key === "Enter" || event.key === " ") {
    elements.fileInput.click();
  }
});

renderAll();
