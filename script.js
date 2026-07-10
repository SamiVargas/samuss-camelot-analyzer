import { logoutUser, watchAuthState } from "./connection.js";

const ANALYSIS_SECONDS = 10;
const MIN_BPM = 70;
const MAX_BPM = 190;
const NOTE_NAMES = ["C", "C#", "D", "Eb", "E", "F", "F#", "G", "Ab", "A", "Bb", "B"];
const MAJOR_NOTE_NAMES = ["C", "Db", "D", "Eb", "E", "F", "F#", "G", "Ab", "A", "Bb", "B"];
const MINOR_NOTE_NAMES = ["C", "C#", "D", "Eb", "E", "F", "F#", "G", "Ab", "A", "Bb", "B"];
const MAJOR_PROFILE = [6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88];
const MINOR_PROFILE = [6.33, 2.68, 3.52, 5.38, 2.60, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17];

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
 * Protege la pantalla principal: si no hay usuario, vuelve al login.
 */
watchAuthState((user) => {
  if (!user) window.location.href = "login.html";
});

/**
 * Retorna un unico AudioContext compartido para todo el analisis.
 */
function getAudioContext() {
  if (!state.audioContext) {
    state.audioContext = new AudioContext();
  }

  return state.audioContext;
}

/**
 * Normaliza nombres enharmonicos para comparar con la tabla Camelot.
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
 * Formatea segundos en mm:ss.
 */
function formatDuration(seconds) {
  if (!Number.isFinite(seconds) || seconds <= 0) return "--:--";
  const minutes = Math.floor(seconds / 60);
  const remainingSeconds = Math.round(seconds % 60).toString().padStart(2, "0");
  return `${minutes}:${remainingSeconds}`;
}

/**
 * Formatea bytes como megabytes.
 */
function formatFileSize(bytes) {
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

/**
 * Obtiene la extension del archivo.
 */
function getFileFormat(fileName) {
  return fileName.split(".").pop().toUpperCase();
}

/**
 * Crea el modelo interno de una cancion local.
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
    progress: 0,
    status: "Pendiente"
  };
}

/**
 * Agrega archivos MP3/WAV validos a la cola local.
 */
function addFiles(fileList) {
  const validFiles = [...fileList].filter((file) => ["MP3", "WAV"].includes(getFileFormat(file.name)));
  state.tracks.push(...validFiles.map(createTrackFromFile));
  renderAll();
}

/**
 * Decodifica el audio y toma una ventana de maximo 10 segundos para DSP.
 */
async function decodeAudioWindow(file) {
  const audioContext = getAudioContext();
  const arrayBuffer = await file.arrayBuffer();
  const audioBuffer = await audioContext.decodeAudioData(arrayBuffer.slice(0));
  const sampleRate = audioBuffer.sampleRate;
  const requestedSamples = Math.min(audioBuffer.length, sampleRate * ANALYSIS_SECONDS);
  const monoSamples = new Float32Array(requestedSamples);

  for (let channel = 0; channel < audioBuffer.numberOfChannels; channel += 1) {
    const channelSamples = audioBuffer.getChannelData(channel).subarray(0, requestedSamples);
    for (let index = 0; index < requestedSamples; index += 1) {
      monoSamples[index] += channelSamples[index] / audioBuffer.numberOfChannels;
    }
  }

  return { monoSamples, sampleRate, duration: audioBuffer.duration };
}

/**
 * Calcula energia RMS para un segmento.
 */
function getRms(samples, start, size) {
  let sum = 0;
  for (let index = start; index < Math.min(start + size, samples.length); index += 1) {
    sum += samples[index] * samples[index];
  }
  return Math.sqrt(sum / size);
}

/**
 * Estima BPM mediante deteccion de picos de energia.
 */
function estimateBpm(samples, sampleRate) {
  const frameSize = 1024;
  const hopSize = 512;
  const envelope = [];

  for (let start = 0; start + frameSize < samples.length; start += hopSize) {
    envelope.push(getRms(samples, start, frameSize));
  }

  const averageEnergy = envelope.reduce((sum, value) => sum + value, 0) / Math.max(envelope.length, 1);
  const peaks = [];

  for (let index = 1; index < envelope.length - 1; index += 1) {
    const isLocalPeak = envelope[index] > envelope[index - 1] && envelope[index] > envelope[index + 1];
    const isStrongPeak = envelope[index] > averageEnergy * 1.25;
    if (isLocalPeak && isStrongPeak) peaks.push((index * hopSize) / sampleRate);
  }

  if (peaks.length < 2) return null;

  const intervals = [];
  for (let index = 1; index < peaks.length; index += 1) {
    const interval = peaks[index] - peaks[index - 1];
    if (interval > 0.24 && interval < 1.3) intervals.push(interval);
  }

  if (!intervals.length) return null;

  intervals.sort((a, b) => a - b);
  const medianInterval = intervals[Math.floor(intervals.length / 2)];
  let bpm = Math.round(60 / medianInterval);

  while (bpm < MIN_BPM) bpm *= 2;
  while (bpm > MAX_BPM) bpm = Math.round(bpm / 2);

  return bpm;
}

/**
 * Calcula la energia de una frecuencia usando Goertzel.
 * Este metodo es mas estable para deteccion tonal que tomar pocas muestras sueltas.
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

  return Math.sqrt(previous2 * previous2 + previous * previous - coefficient * previous * previous2);
}

/**
 * Construye un vector cromatico de 12 clases de tono usando varias octavas y armonicos.
 */
function buildChromaVector(samples, sampleRate) {
  const chroma = new Array(12).fill(0);
  const nyquist = sampleRate / 2;

  for (let midi = 36; midi <= 84; midi += 1) {
    const frequency = 440 * 2 ** ((midi - 69) / 12);
    const pitchClass = midi % 12;
    const octaveWeight = midi >= 48 && midi <= 72 ? 1 : 0.65;
    const fundamental = getFrequencyMagnitude(samples, sampleRate, frequency);
    const secondHarmonic = frequency * 2 < nyquist ? getFrequencyMagnitude(samples, sampleRate, frequency * 2) * 0.35 : 0;
    const thirdHarmonic = frequency * 3 < nyquist ? getFrequencyMagnitude(samples, sampleRate, frequency * 3) * 0.18 : 0;
    chroma[pitchClass] += (fundamental + secondHarmonic + thirdHarmonic) * octaveWeight;
  }

  const maxValue = Math.max(...chroma, 1);
  return chroma.map((value) => value / maxValue);
}

/**
 * Rota un perfil tonal hacia una tonica.
 */
function rotateProfile(profile, steps) {
  return profile.map((_value, index) => profile[(index - steps + 12) % 12]);
}

/**
 * Calcula correlacion entre cromagrama y perfil tonal.
 */
function correlate(chroma, profile) {
  const chromaMean = chroma.reduce((sum, value) => sum + value, 0) / chroma.length;
  const profileMean = profile.reduce((sum, value) => sum + value, 0) / profile.length;

  return chroma.reduce((sum, value, index) => {
    return sum + (value - chromaMean) * (profile[index] - profileMean);
  }, 0);
}

/**
 * Detecta tonalidad y modo usando perfiles tonales Krumhansl.
 */
function detectMusicalKey(samples, sampleRate) {
  const chroma = buildChromaVector(samples, sampleRate);
  let bestResult = { tonicIndex: 0, mode: "Major", score: Number.NEGATIVE_INFINITY };

  for (let tonicIndex = 0; tonicIndex < 12; tonicIndex += 1) {
    const majorScore = correlate(chroma, rotateProfile(MAJOR_PROFILE, tonicIndex));
    const minorScore = correlate(chroma, rotateProfile(MINOR_PROFILE, tonicIndex));

    if (majorScore > bestResult.score) bestResult = { tonicIndex, mode: "Major", score: majorScore };
    if (minorScore > bestResult.score) bestResult = { tonicIndex, mode: "Minor", score: minorScore };
  }

  const noteNames = bestResult.mode === "Major" ? MAJOR_NOTE_NAMES : MINOR_NOTE_NAMES;
  const detectedKeyName = `${noteNames[bestResult.tonicIndex]} ${bestResult.mode}`;
  const camelotKey = convertKeyToCamelot(detectedKeyName);

  return {
    keyName: camelotToKey.get(camelotKey) || detectedKeyName,
    mode: bestResult.mode
  };
}

/**
 * Convierte una tonalidad musical a clave Camelot.
 */
function convertKeyToCamelot(keyName) {
  return keyToCamelot.get(normalizeKeyName(keyName)) || "--";
}

/**
 * Analiza una cancion de forma local en el navegador.
 */
async function analyzeTrack(track) {
  track.status = "Analizando";
  track.progress = 20;
  renderAll();

  const audioWindow = await decodeAudioWindow(track.file);
  track.duration = audioWindow.duration;
  track.progress = 45;
  renderAll();

  track.bpm = estimateBpm(audioWindow.monoSamples, audioWindow.sampleRate);
  track.progress = 70;
  renderAll();

  const keyResult = detectMusicalKey(audioWindow.monoSamples, audioWindow.sampleRate);
  track.key = keyResult.keyName;
  track.mode = keyResult.mode;
  track.camelot = convertKeyToCamelot(track.key);
  track.status = "Analizado localmente";
  track.progress = 100;
  renderAll();
}

/**
 * Analiza todas las canciones pendientes de forma secuencial.
 */
async function analyzeAllTracks() {
  elements.analyzeButton.disabled = true;
  try {
    for (const track of state.tracks) {
      if (!track.camelot) await analyzeTrack(track);
    }
  } finally {
    elements.analyzeButton.disabled = false;
  }
}

/**
 * Limpia caracteres no permitidos para nombres de archivo descargados.
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
 * Descarga un archivo local con un nombre nuevo basado en Camelot.
 */
function downloadRenamedTrack(track) {
  if (!track.camelot || track.camelot === "--") return;

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
 * Descarga todas las canciones analizadas con nombre Camelot.
 */
function downloadAllRenamedTracks() {
  state.tracks.filter((track) => track.camelot).forEach(downloadRenamedTrack);
}

/**
 * Convierte clave Camelot en numero y letra.
 */
function parseCamelotKey(camelotKey) {
  const match = /^(\d{1,2})(A|B)$/.exec(camelotKey || "");
  if (!match) return null;
  return { number: Number(match[1]), letter: match[2] };
}

/**
 * Mantiene los numeros Camelot en rango circular 1-12.
 */
function normalizeCamelotNumber(number) {
  return ((number - 1 + 12) % 12) + 1;
}

/**
 * Puntua una transicion segun las reglas solicitadas.
 */
function getTransitionScore(fromTrack, toTrack) {
  const from = parseCamelotKey(fromTrack.camelot);
  const to = parseCamelotKey(toTrack.camelot);

  if (!from || !to) return { score: 0, label: "Sin regla Camelot" };
  if (from.number === to.number && from.letter === to.letter) return { score: 100, label: "Mismo Camelot" };
  if (from.number === to.number && from.letter !== to.letter) return { score: 90, label: to.letter === "B" ? "Relative Major" : "Relative Minor" };
  if (from.letter === to.letter && normalizeCamelotNumber(from.number + 1) === to.number) return { score: 80, label: "+1" };
  if (from.letter === to.letter && normalizeCamelotNumber(from.number - 1) === to.number) return { score: 80, label: "-1" };
  if (from.letter === to.letter && normalizeCamelotNumber(from.number + 7) === to.number) return { score: 70, label: "Energy Boost" };
  if (from.letter === to.letter && normalizeCamelotNumber(from.number - 7) === to.number) return { score: 70, label: "Energy Boost" };

  return { score: 10, label: "Transicion libre" };
}

/**
 * Busca la mejor siguiente cancion armonica.
 */
function findBestNextTrack(currentTrack, remainingTracks) {
  return remainingTracks
    .map((track) => {
      const transition = getTransitionScore(currentTrack, track);
      const bpmPenalty = currentTrack.bpm && track.bpm ? Math.abs(currentTrack.bpm - track.bpm) * 0.3 : 0;
      return { track, transition, finalScore: transition.score - bpmPenalty };
    })
    .sort((a, b) => b.finalScore - a.finalScore)[0];
}

/**
 * Construye una playlist armonica con estrategia greedy.
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
    orderedPlaylist.push({ track: bestCandidate.track, transition: bestCandidate.transition.label });
  }

  state.orderedPlaylist = orderedPlaylist;
  renderPlaylist();
}

/**
 * Descarga la playlist final en CSV.
 */
function downloadPlaylistCsv() {
  if (!state.orderedPlaylist.length) return;

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
 * Elimina una cancion de la interfaz.
 */
function removeTrack(trackId) {
  state.tracks = state.tracks.filter((track) => track.id !== trackId);
  state.orderedPlaylist = state.orderedPlaylist.filter((item) => item.track.id !== trackId);
  renderAll();
}

/**
 * Limpia toda la cola local.
 */
function clearTracks() {
  state.tracks = [];
  state.orderedPlaylist = [];
  renderAll();
}

/**
 * Renderiza las tarjetas de canciones.
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
 * Renderiza la tabla de resultados.
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
      <td>${track.key || "--"}</td>
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
 * Renderiza todas las secciones dinamicas.
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
  if (event.key === "Enter" || event.key === " ") elements.fileInput.click();
});

renderAll();
