/**
 * Storage de configurações (logo, imagem hero) em data/settings.json.
 * Mesmo padrão de escrita atómica do db.js.
 */
const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, '..', 'data');
const FILE = path.join(DATA_DIR, 'settings.json');
const TMP_FILE = path.join(DATA_DIR, 'settings.json.tmp');

if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

let state = {
  logoPath: null,        // ex: "/uploads/logo.png"
  logoVersion: null,     // timestamp p/ cachebust
  heroPath: null,        // ex: "/uploads/hero.png"
  heroVersion: null,
};

let writing = false;
let pendingWrite = false;

function loadFromDisk() {
  try {
    if (fs.existsSync(FILE)) {
      const data = JSON.parse(fs.readFileSync(FILE, 'utf8'));
      if (data && typeof data === 'object') {
        state = Object.assign(state, data);
        console.log('[i] Settings carregadas');
      }
    } else {
      console.log('[i] Settings novo criado em ' + FILE);
    }
  } catch (err) {
    console.error('[!] Erro a ler settings, comeco vazio:', err.message);
  }
}

async function persist() {
  if (writing) { pendingWrite = true; return; }
  writing = true;
  try {
    await fs.promises.writeFile(TMP_FILE, JSON.stringify(state, null, 2), 'utf8');
    await fs.promises.rename(TMP_FILE, FILE);
  } catch (err) {
    console.error('[X] Erro a persistir settings:', err.message);
  } finally {
    writing = false;
    if (pendingWrite) { pendingWrite = false; persist(); }
  }
}

// Recarrega do disco (útil em caso de multi-instância)
function reloadFromDisk() {
  try {
    if (fs.existsSync(FILE)) {
      const data = JSON.parse(fs.readFileSync(FILE, 'utf8'));
      if (data && typeof data === 'object') {
        state = Object.assign({ logoPath: null, logoVersion: null, heroPath: null, heroVersion: null }, data);
      }
    }
  } catch (err) { /* silent */ }
  return state;
}

loadFromDisk();

module.exports = {
  read() {
    reloadFromDisk();
    return Object.assign({}, state);
  },

  setLogo(filename) {
    reloadFromDisk();
    state.logoPath = '/uploads/' + filename;
    state.logoVersion = Date.now();
    persist();
    return Object.assign({}, state);
  },

  setHero(filename) {
    reloadFromDisk();
    state.heroPath = '/uploads/' + filename;
    state.heroVersion = Date.now();
    persist();
    return Object.assign({}, state);
  },

  // Retorna o path com cachebust ?v=...
  getLogoUrl() {
    reloadFromDisk();
    if (!state.logoPath) return null;
    return state.logoPath + '?v=' + (state.logoVersion || Date.now());
  },

  getHeroUrl() {
    reloadFromDisk();
    if (!state.heroPath) return null;
    return state.heroPath + '?v=' + (state.heroVersion || Date.now());
  },
};
