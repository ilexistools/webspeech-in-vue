<script setup>
import { onMounted, ref, computed, watch } from "vue";
import { createPersist } from "./lib/persist";
import { createSpeechBridge } from "./lib/speechBridge";

const drawer = ref(false);

const isRunning = ref(false);
const statusText = computed(function() { return isRunning.value ? "Gravando" : "Parado"; });
const bannerMsg = ref("Clique em Iniciar para começar a transcrição em tempo real usando Web Speech API.");

const language = ref("pt");

const transcriptHtml = ref("[A transcrição vai aparecer aqui]");
const partialText = ref("");

const timerLabel = ref("00m 00s");

const debugText = ref("");

const persistState = ref("inicializando...");
const activeSessionLabel = ref("-");
const lastSaveLabel = ref("-");

const sessions = ref([]);
const selectedSessionId = ref(null);

let persist = null;
let bridge = null;

const DEBUG_LIMIT = 200000;

function appendDebug(line) {
  const s = String(line != null ? line : "");
  debugText.value += (debugText.value ? "\n" : "") + s;

  if (debugText.value.length > DEBUG_LIMIT) {
    debugText.value = debugText.value.slice(-DEBUG_LIMIT);
  }
}

function onStart() {
  const ok = bridge && bridge.start ? bridge.start() : false;
  if (!ok) bannerMsg.value = "Falha ao iniciar. Verifique o suporte do navegador.";
}

function onStop() {
  if (bridge && bridge.stop) bridge.stop();
}

function clearTranscript() {
  if (bridge && bridge.clearTranscript) bridge.clearTranscript();
  if (persist && persist.scheduleAutosave) persist.scheduleAutosave();
}

function exportTranscript() {
  const tmp = document.createElement("div");
  tmp.innerHTML = transcriptHtml.value || "";
  const text = (tmp.innerText || "").trim();
  if (!text) return;

  if (persist && persist.autosaveNow) {
    persist.autosaveNow("manual").catch(function() {});
  }

  const blob = new Blob([text], { type: "text/plain;charset=utf-8" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = "transcricao.txt";
  document.body.appendChild(a);
  a.click();
  setTimeout(function() {
    URL.revokeObjectURL(a.href);
    a.remove();
  }, 0);
}

async function recoverLast() {
  const id = persist && persist.getActiveSessionId ? persist.getActiveSessionId() : null;
  if (!id) return;
  await persist.restoreSessionById(id);
  bannerMsg.value = "Sessão ativa recuperada.";
}

async function newSession() {
  if (isRunning.value) onStop();

  transcriptHtml.value = "[A transcrição vai aparecer aqui]";
  partialText.value = "";
  timerLabel.value = "00m 00s";

  await persist.createNewSession(true);
  selectedSessionId.value = persist.getActiveSessionId ? persist.getActiveSessionId() : null;

  bannerMsg.value = "Nova sessão criada. Você pode começar do zero.";
}

async function deleteSession() {
  const id = selectedSessionId.value || (persist && persist.getActiveSessionId ? persist.getActiveSessionId() : null);
  if (!id) return;

  if (isRunning.value) onStop();

  await persist.deleteSession(id);

  selectedSessionId.value = persist.getActiveSessionId ? persist.getActiveSessionId() : null;

  transcriptHtml.value = "[A transcrição vai aparecer aqui]";
  partialText.value = "";
  timerLabel.value = "00m 00s";

  bannerMsg.value = "Sessão apagada.";
}

async function loadSelectedSession() {
  const id = selectedSessionId.value;
  if (!id) return;

  if (isRunning.value) onStop();

  await persist.restoreSessionById(id);
  bannerMsg.value = "Sessão carregada.";
}

async function makeSelectedActive() {
  const id = selectedSessionId.value;
  if (!id) return;

  if (isRunning.value) onStop();

  await persist.setActiveSession(id);
  await persist.restoreSessionById(id);
  bannerMsg.value = "Sessão selecionada definida como ativa.";
}

// Atualiza o idioma no bridge quando mudar
watch(language, function(newLang) {
  if (bridge && bridge.setLanguage) {
    bridge.setLanguage(newLang);
    appendDebug("Idioma alterado para: " + newLang);
  }
});

onMounted(async function() {
  appendDebug("Iniciando aplicação Web Speech API...");

  // Verifica suporte
  const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SpeechRecognition) {
    appendDebug("ERRO: Web Speech API não suportada neste navegador");
    bannerMsg.value = "Seu navegador não suporta Web Speech API. Use Chrome, Edge ou Safari.";
    persistState.value = "sem suporte";
    return;
  }

  appendDebug("Web Speech API detectada");

  // Cria persistência
  try {
    persist = createPersist({
      getTranscriptHtml: function() { return bridge ? bridge.getTranscriptHtml() : ""; },
      getNLines: function() { return bridge ? bridge.getNLines() : 0; },
      getLanguage: function() { return language.value; },
      getWasRecording: function() { return isRunning.value; },

      setTranscriptHtml: function(h) { if (bridge) bridge.setTranscriptHtml(h); },
      setNLines: function(n) { if (bridge) bridge.setNLines(n); },
      setLanguage: function(l) { language.value = l; },

      onBanner: function(msg) { bannerMsg.value = msg; },
      onPersistUI: function(patch) {
        if (patch.persistState != null) persistState.value = patch.persistState;
        if (patch.activeSessionLabel != null) activeSessionLabel.value = patch.activeSessionLabel;
        if (patch.lastSaveLabel != null) lastSaveLabel.value = patch.lastSaveLabel;
        if (patch.sessions != null) sessions.value = patch.sessions;
      }
    });

    await persist.init();
    appendDebug("Persistência inicializada");
  } catch (e) {
    appendDebug("Erro ao inicializar persistência: " + String(e));
  }

  // Cria bridge
  bridge = createSpeechBridge({
    onBanner: function(msg) { bannerMsg.value = msg; },
    onStatus: function(s) { isRunning.value = s.isRunning; },
    onTimer: function(t) { timerLabel.value = t; },
    onTranscriptHtml: function(h) { transcriptHtml.value = h; },
    onPartialText: function(t) { partialText.value = t; },
    onDebug: appendDebug,
    getLanguage: function() { return language.value; },
    persist: persist
  });

  bridge.init();
  appendDebug("Speech Bridge inicializado");

  bannerMsg.value = "Pronto! Clique em Iniciar para começar a transcrição.";
});
</script>

<template>
  <v-app>
    <v-main style="background:#fbfcfe;">
      <v-container fluid style="max-width:1200px; height:100vh; display:flex; flex-direction:column; padding:16px;">
        
        <!-- HEADER -->
        <div class="d-flex align-center justify-space-between mb-4" style="flex-shrink: 0;">
          <div class="d-flex align-center ga-3">
            <v-icon size="32" color="primary">mdi-microphone</v-icon>
            <div>
              <h1 style="font-size:20px; font-weight:900; color:#111827;">Transcrição em Tempo Real</h1>
              <p style="font-size:13px; color:#6b7280; margin:0;">Web Speech API</p>
            </div>
          </div>
          
          <v-chip 
            :color="isRunning ? 'error' : 'grey'" 
            variant="flat"
            label
            style="font-weight:900;"
          >
            {{ statusText }}
          </v-chip>
        </div>

        <!-- CARD PRINCIPAL -->
        <v-card 
          rounded="xl" 
          elevation="1" 
          style="flex: 1 1 auto; min-height: 0; display: flex; flex-direction: column; border:1px solid #e5e7eb;"
        >
          <div 
            class="d-flex align-center justify-space-between flex-wrap ga-3 px-4 py-3" 
            style="border-bottom:1px solid #e5e7eb; background:white; flex-shrink: 0;"
          >
            <div class="d-flex align-center ga-2">
              <v-chip 
                size="small" 
                label
                style="background:#e8f1ff; color:#1d4ed8; border:1px solid #c7ddff; font-weight:900;"
              >INÍCIO</v-chip>
              <span style="font-size: 13px; font-weight: 700;">{{ bannerMsg }}</span>
            </div>

            <div class="d-flex align-center flex-wrap ga-2">
              <v-btn color="black" variant="flat" @click="drawer = true">Configurações</v-btn>
            </div>
          </div>

          <div class="pa-4" style="flex: 1 1 auto; min-height: 0; display:flex; flex-direction:column; gap:12px;">
            <div class="d-flex align-center ga-2" style="color:#6b7280;">
              <v-icon size="18">mdi-dots-horizontal</v-icon>
              <span style="font-size:14px; font-weight:700;">
                Clique em Iniciar e permita o acesso ao microfone para começar
              </span>
            </div>

            <v-card
              variant="outlined"
              rounded="lg"
              style="border-color:#eef2f7; flex: 1 1 auto; min-height:0; overflow:auto;"
            >
              <v-card-text style="line-height:1.55; font-size:14px;">
                <div v-html="transcriptHtml" style="color:#111827;"></div>
                <div style="color:#6b7280; font-style:italic;">{{ partialText }}</div>
              </v-card-text>
            </v-card>
          </div>

          <div
            class="d-flex align-center justify-space-between flex-wrap ga-3 px-4 py-3"
            style="border-top:1px solid #e5e7eb; background:#fbfcfe;"
          >
            <div class="d-flex align-center flex-wrap ga-2">
              <v-btn
                icon
                variant="outlined"
                size="large"
                @click="onStart"
                style="border-radius:999px; width:42px; height:42px;"
                title="Iniciar"
              >
                <v-icon :color="isRunning ? 'red' : 'grey'">mdi-circle</v-icon>
              </v-btn>

              <v-btn variant="outlined" :disabled="!isRunning" @click="onStop">Parar</v-btn>

              <v-chip label variant="outlined" style="font-variant-numeric: tabular-nums; font-weight:800; color:#6b7280;">
                {{ timerLabel }}
              </v-chip>
            </div>

            <div class="d-flex align-center flex-wrap ga-2">
              <v-btn variant="outlined" @click="clearTranscript">Limpar</v-btn>
              <v-btn variant="outlined" @click="exportTranscript">Exportar</v-btn>
              <v-btn icon variant="outlined" @click="drawer = true" title="Configurações">
                <v-icon>mdi-cog</v-icon>
              </v-btn>
            </div>
          </div>
        </v-card>

        <v-navigation-drawer 
          v-model="drawer" 
          location="right" 
          temporary 
          width="420"
        >
          <div style="display: flex; flex-direction: column; height: 100vh;">
            <div class="d-flex align-center justify-space-between px-4 py-3" style="border-bottom:1px solid #e5e7eb; flex-shrink: 0;">
              <div class="text-subtitle-2 font-weight-black">Configurações</div>
              <v-btn variant="outlined" size="small" @click="drawer=false">Fechar</v-btn>
            </div>

            <div class="pa-4" style="flex: 1; overflow-y: auto; background:#fbfcfe;">
              
              <!-- SOBRE WEB SPEECH API -->
              <v-card variant="outlined" rounded="lg" class="mb-4">
                <v-card-text>
                  <div class="font-weight-black mb-3" style="font-size:14px;">
                    <v-icon size="20" color="primary" class="mr-2">mdi-information</v-icon>
                    Web Speech API
                  </div>
                  
                  <div style="font-size:12px; color:#6b7280; line-height:1.6;">
                    Esta aplicação usa a <b>Web Speech API</b> nativa do navegador, 
                    que funciona online sem necessidade de baixar modelos.
                    <br><br>
                    <b>Navegadores suportados:</b>
                    <ul style="margin: 8px 0; padding-left: 20px;">
                      <li>Google Chrome</li>
                      <li>Microsoft Edge</li>
                      <li>Safari (macOS/iOS)</li>
                    </ul>
                    <br>
                    <b>Requisitos:</b>
                    <ul style="margin: 8px 0; padding-left: 20px;">
                      <li>Conexão com internet</li>
                      <li>Permissão de microfone</li>
                    </ul>
                  </div>
                </v-card-text>
              </v-card>

              <!-- IDIOMA -->
              <v-card variant="outlined" rounded="lg" class="mb-4">
                <v-card-text>
                  <div class="font-weight-black mb-2" style="font-size:13px;">Idioma da Transcrição</div>
                  <v-select
                    v-model="language"
                    :items="[
                      { title:'Português (Brasil)', value:'pt' },
                      { title:'English (US)', value:'en' }
                    ]"
                    variant="outlined"
                    density="comfortable"
                  />
                  <div style="font-size:11px; color:#6b7280; margin-top:8px;">
                    <v-icon size="14" color="warning">mdi-alert-circle</v-icon>
                    Para trocar o idioma durante a gravação, pare e reinicie.
                  </div>
                </v-card-text>
              </v-card>

              <!-- PERSISTÊNCIA -->
              <v-card variant="outlined" rounded="lg" class="mb-4">
                <v-card-text>
                  <div class="d-flex justify-space-between align-start ga-2 mb-3">
                    <div>
                      <div class="font-weight-black" style="font-size:13px;">Persistência</div>
                      <div style="color:#6b7280; font-size:11px;">Salvamento automático</div>
                    </div>
                    <v-chip size="small" :color="persistState === 'ativo' ? 'success' : 'warning'">
                      {{ persistState }}
                    </v-chip>
                  </div>

                  <div style="display:grid; gap:6px; font-size:12px; color:#6b7280;">
                    <div class="d-flex justify-space-between">
                      <span>Sessão ativa</span><b style="color:#111827;">{{ activeSessionLabel }}</b>
                    </div>
                    <div class="d-flex justify-space-between">
                      <span>Último autosave</span><b style="color:#111827;">{{ lastSaveLabel }}</b>
                    </div>
                  </div>

                  <v-divider class="my-3" />

                  <div class="d-flex ga-2 flex-wrap mb-3">
                    <v-btn variant="outlined" size="small" @click="recoverLast">Recuperar</v-btn>
                    <v-btn variant="outlined" size="small" @click="newSession">Nova</v-btn>
                    <v-btn variant="outlined" size="small" color="error" @click="deleteSession">Apagar</v-btn>
                  </div>

                  <v-select
                    v-model="selectedSessionId"
                    :items="sessions.map(function(s) { return {
                      title: (s.title || s.id) + (s.isActive ? ' (ativa)' : ''),
                      value: s.id
                    }; })"
                    variant="outlined"
                    density="compact"
                    label="Sessões salvas"
                    class="mb-2"
                  />

                  <div class="d-flex ga-2 flex-wrap">
                    <v-btn variant="text" size="small" @click="loadSelectedSession">Carregar</v-btn>
                    <v-btn variant="text" size="small" @click="makeSelectedActive">Definir ativa</v-btn>
                  </div>
                </v-card-text>
              </v-card>

              <!-- DEBUG -->
              <v-card variant="outlined" rounded="lg">
                <v-card-text>
                  <div class="font-weight-black mb-2" style="font-size:13px;">Debug</div>
                  <v-textarea
                    v-model="debugText"
                    readonly
                    variant="outlined"
                    density="compact"
                    rows="8"
                    style="font-family: monospace; font-size: 11px;"
                  />
                </v-card-text>
              </v-card>

            </div>
          </div>
        </v-navigation-drawer>
      </v-container>
    </v-main>
  </v-app>
</template>