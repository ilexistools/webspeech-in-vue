// src/lib/speechBridge.js
// Ponte robusta entre Vue e Web Speech API
// Estratégias anti-interrupção implementadas:
// 1. Reinício automático com backoff exponencial
// 2. Watchdog timer para detectar travamentos silenciosos
// 3. Dual recognition (overlap) para eliminar gaps
// 4. Buffer de resultados pendentes
// 5. Tratamento de visibilidade da página
// 6. Reconexão resiliente a erros de rede

export function createSpeechBridge(opts) {
  const {
    onBanner,
    onStatus,
    onTimer,
    onTranscriptHtml,
    onPartialText,
    onDebug,
    getLanguage: getLanguageOpt,
    persist,
  } = opts || {};

  // ═══════════════════════════════════════════════════════════════════
  // CONFIGURAÇÕES DE ROBUSTEZ
  // ═══════════════════════════════════════════════════════════════════
  const CONFIG = {
    // Watchdog: tempo máximo sem eventos antes de forçar reinício
    WATCHDOG_TIMEOUT_MS: 3100,
    WATCHDOG_CHECK_INTERVAL_MS: 1000,

    // Backoff para reconexão após erros
    INITIAL_RETRY_DELAY_MS: 100,
    MAX_RETRY_DELAY_MS: 3000,
    RETRY_MULTIPLIER: 1.5,

    // Dual recognition: overlap para eliminar gaps
    USE_DUAL_RECOGNITION: true,
    OVERLAP_RESTART_DELAY_MS: 50,

    // Limite de tentativas consecutivas antes de pausa
    MAX_CONSECUTIVE_ERRORS: 10,
    ERROR_COOLDOWN_MS: 3000,

    // Buffer de segurança
    RESULT_DEBOUNCE_MS: 100,
  };

  // ═══════════════════════════════════════════════════════════════════
  // ESTADO
  // ═══════════════════════════════════════════════════════════════════
  
  // Reconhecimento principal e secundário (dual)
  let recognition = null;
  let recognitionBackup = null;
  let activeRecognition = "primary"; // "primary" | "backup"

  // Estado de transcrição
  let transcribedAll = "";
  let nLines = 0;
  let currentPartial = "";
  let pendingFinals = []; // Buffer de resultados finais pendentes

  // Estado de gravação
  let isRecording = false;
  let shouldBeRecording = false; // Intenção do usuário
  let startTime = 0;
  let timerInterval = null;

  // Estado de robustez
  let lastEventTime = 0;
  let watchdogInterval = null;
  let retryDelay = CONFIG.INITIAL_RETRY_DELAY_MS;
  let consecutiveErrors = 0;
  let isRestarting = false;
  let restartTimeout = null;

  // Debounce para resultados
  let resultDebounceTimer = null;

  // ═══════════════════════════════════════════════════════════════════
  // UTILIDADES
  // ═══════════════════════════════════════════════════════════════════

  function dbg(msg) {
    const timestamp = new Date().toISOString().split("T")[1].slice(0, 12);
    try {
      onDebug && onDebug(`[${timestamp}] ${msg}`);
    } catch (e) {}
    // Também loga no console para debug
    // console.log(`[SpeechBridge ${timestamp}] ${msg}`);
  }

  function setBanner(msg) {
    try {
      onBanner && onBanner(msg);
    } catch (e) {}
  }

  function formatMMSS(ms) {
    const s0 = Math.max(0, Math.floor(ms / 1000));
    const m = Math.floor(s0 / 60);
    const s = s0 % 60;
    return String(m).padStart(2, "0") + "m " + String(s).padStart(2, "0") + "s";
  }

  function emitStatus() {
    try {
      onStatus && onStatus({ isRunning: isRecording });
    } catch (e) {}
  }

  function emitTimer() {
    try {
      onTimer && onTimer(isRecording ? formatMMSS(Date.now() - startTime) : "00m 00s");
    } catch (e) {}
  }

  function emitTranscript() {
    try {
      onTranscriptHtml && onTranscriptHtml(
        transcribedAll && transcribedAll.length 
          ? transcribedAll 
          : "[A transcrição vai aparecer aqui]"
      );
    } catch (e) {}
  }

  function emitPartial() {
    try {
      onPartialText && onPartialText(currentPartial);
    } catch (e) {}
  }

  function scheduleAutosave() {
    try {
      persist && persist.scheduleAutosave && persist.scheduleAutosave();
    } catch (e) {}
  }

  function touchWatchdog() {
    lastEventTime = Date.now();
  }

  function resetRetryState() {
    retryDelay = CONFIG.INITIAL_RETRY_DELAY_MS;
    consecutiveErrors = 0;
  }

  function incrementRetryDelay() {
    retryDelay = Math.min(retryDelay * CONFIG.RETRY_MULTIPLIER, CONFIG.MAX_RETRY_DELAY_MS);
  }

  // ═══════════════════════════════════════════════════════════════════
  // PROCESSAMENTO DE RESULTADOS (com buffer)
  // ═══════════════════════════════════════════════════════════════════

  function processBufferedResults() {
    if (pendingFinals.length === 0) return;

    // Concatena todos os resultados pendentes
    const combined = pendingFinals.join(" ").trim();
    pendingFinals = [];

    if (combined) {
      transcribedAll += combined + "<br>";
      nLines++;
      
      dbg(`Nova linha transcrita: "${combined.substring(0, 50)}${combined.length > 50 ? '...' : ''}"`);
      
      // Mantém últimas 50 linhas
      if (nLines > 50) {
        const lines = transcribedAll.split("<br>");
        transcribedAll = lines.slice(-50).join("<br>");
        nLines = 50;
      }

      emitTranscript();
      scheduleAutosave();
    }
  }

  function addFinalResult(text) {
    if (!text || !text.trim()) return;
    
    pendingFinals.push(text.trim());
    
    // Debounce para agrupar resultados que chegam em rajada
    if (resultDebounceTimer) clearTimeout(resultDebounceTimer);
    resultDebounceTimer = setTimeout(() => {
      resultDebounceTimer = null;
      processBufferedResults();
    }, CONFIG.RESULT_DEBOUNCE_MS);
  }

  // ═══════════════════════════════════════════════════════════════════
  // CRIAÇÃO DE INSTÂNCIA DE RECONHECIMENTO
  // ═══════════════════════════════════════════════════════════════════

  function createRecognitionInstance(label) {
    const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
    
    if (!SpeechRecognition) {
      return null;
    }

    const rec = new SpeechRecognition();
    
    // Configurações otimizadas para continuidade
    rec.continuous = true;
    rec.interimResults = true;
    rec.maxAlternatives = 1;
    
    const lang = (getLanguageOpt && getLanguageOpt()) || "pt-BR";
    rec.lang = lang === "pt" ? "pt-BR" : "en-US";

    // Marca para identificação
    rec._label = label;
    rec._isStarted = false;

    // ─────────────────────────────────────────────────────────────────
    // EVENT HANDLERS
    // ─────────────────────────────────────────────────────────────────

    rec.onstart = function() {
      dbg(`[${label}] Reconhecimento iniciado`);
      rec._isStarted = true;
      touchWatchdog();
      resetRetryState();
      
      if (shouldBeRecording && !isRecording) {
        isRecording = true;
        emitStatus();
      }
    };

    rec.onaudiostart = function() {
      dbg(`[${label}] Áudio iniciado`);
      touchWatchdog();
    };

    rec.onsoundstart = function() {
      dbg(`[${label}] Som detectado`);
      touchWatchdog();
    };

    rec.onspeechstart = function() {
      dbg(`[${label}] Fala detectada`);
      touchWatchdog();
    };

    rec.onspeechend = function() {
      dbg(`[${label}] Fala terminada`);
      touchWatchdog();
    };

    rec.onsoundend = function() {
      dbg(`[${label}] Som terminado`);
      touchWatchdog();
    };

    rec.onaudioend = function() {
      dbg(`[${label}] Áudio terminado`);
      touchWatchdog();
    };

    rec.onend = function() {
      dbg(`[${label}] Reconhecimento finalizado`);
      rec._isStarted = false;
      touchWatchdog();
      
      // Se deveria estar gravando, tenta reiniciar
      if (shouldBeRecording && !isRestarting) {
        dbg(`[${label}] Reinício automático agendado (delay: ${retryDelay}ms)`);
        scheduleRestart(label);
      } else if (!shouldBeRecording) {
        isRecording = false;
        emitStatus();
      }
    };

    rec.onerror = function(event) {
      dbg(`[${label}] Erro: ${event.error}`);
      touchWatchdog();
      
      // Tratamento específico por tipo de erro
      switch (event.error) {
        case "no-speech":
          // Normal, não é erro real - continua
          dbg(`[${label}] Nenhuma fala detectada, continuando...`);
          return;

        case "aborted":
          // Abortado intencionalmente ou por troca de instância
          dbg(`[${label}] Abortado`);
          return;

        case "audio-capture":
          consecutiveErrors++;
          setBanner("Erro ao capturar áudio. Verifique as permissões do microfone.");
          if (consecutiveErrors >= CONFIG.MAX_CONSECUTIVE_ERRORS) {
            handleTooManyErrors();
          }
          break;

        case "not-allowed":
          setBanner("Permissão de microfone negada. Por favor, autorize o acesso.");
          shouldBeRecording = false;
          isRecording = false;
          emitStatus();
          return;

        case "network":
          consecutiveErrors++;
          dbg(`[${label}] Erro de rede - tentando reconectar...`);
          setBanner("Erro de rede. Tentando reconectar...");
          incrementRetryDelay();
          break;

        case "service-not-allowed":
          setBanner("Serviço de reconhecimento não disponível.");
          shouldBeRecording = false;
          isRecording = false;
          emitStatus();
          return;

        default:
          consecutiveErrors++;
          dbg(`[${label}] Erro desconhecido: ${event.error}`);
          incrementRetryDelay();
      }

      // Verifica limite de erros
      if (consecutiveErrors >= CONFIG.MAX_CONSECUTIVE_ERRORS) {
        handleTooManyErrors();
      }
    };

    rec.onresult = function(event) {
      touchWatchdog();
      resetRetryState(); // Resultado = conexão OK
      
      let interimTranscript = "";

      // Processa todos os resultados
      for (let i = event.resultIndex; i < event.results.length; i++) {
        const result = event.results[i];
        const transcript = result[0].transcript;
        
        if (result.isFinal) {
          addFinalResult(transcript);
          currentPartial = "";
        } else {
          interimTranscript += transcript;
        }
      }

      // Atualiza texto parcial
      if (interimTranscript) {
        currentPartial = interimTranscript;
        emitPartial();
      } else if (currentPartial) {
        currentPartial = "";
        emitPartial();
      }
    };

    return rec;
  }

  // ═══════════════════════════════════════════════════════════════════
  // REINÍCIO ROBUSTO
  // ═══════════════════════════════════════════════════════════════════

  function scheduleRestart(failedLabel) {
    if (isRestarting || !shouldBeRecording) return;
    
    isRestarting = true;
    
    if (restartTimeout) clearTimeout(restartTimeout);
    
    restartTimeout = setTimeout(() => {
      restartTimeout = null;
      isRestarting = false;
      
      if (!shouldBeRecording) return;
      
      if (CONFIG.USE_DUAL_RECOGNITION) {
        // Dual recognition: alterna para a instância de backup
        performDualRestart(failedLabel);
      } else {
        // Single recognition: reinicia a mesma instância
        performSingleRestart();
      }
    }, retryDelay);
  }

  function performSingleRestart() {
    if (!shouldBeRecording) return;
    
    dbg("Reiniciando reconhecimento único...");
    
    try {
      if (recognition && recognition._isStarted) {
        recognition.abort();
      }
    } catch (e) {}
    
    try {
      if (!recognition) {
        recognition = createRecognitionInstance("primary");
      }
      recognition.start();
    } catch (e) {
      dbg(`Erro ao reiniciar: ${e}`);
      consecutiveErrors++;
      incrementRetryDelay();
      
      if (consecutiveErrors < CONFIG.MAX_CONSECUTIVE_ERRORS) {
        scheduleRestart("primary");
      } else {
        handleTooManyErrors();
      }
    }
  }

  function performDualRestart(failedLabel) {
    if (!shouldBeRecording) return;
    
    // Determina qual instância usar
    const useBackup = failedLabel === "primary";
    const targetLabel = useBackup ? "backup" : "primary";
    
    dbg(`Dual restart: ativando ${targetLabel}...`);
    
    // Cria instância se não existe
    if (useBackup && !recognitionBackup) {
      recognitionBackup = createRecognitionInstance("backup");
    } else if (!useBackup && !recognition) {
      recognition = createRecognitionInstance("primary");
    }
    
    const target = useBackup ? recognitionBackup : recognition;
    
    if (!target) {
      dbg("Falha ao criar instância de reconhecimento");
      handleTooManyErrors();
      return;
    }
    
    try {
      target.start();
      activeRecognition = targetLabel;
      dbg(`${targetLabel} ativado com sucesso`);
    } catch (e) {
      dbg(`Erro ao ativar ${targetLabel}: ${e}`);
      consecutiveErrors++;
      incrementRetryDelay();
      
      if (consecutiveErrors < CONFIG.MAX_CONSECUTIVE_ERRORS) {
        scheduleRestart(targetLabel);
      } else {
        handleTooManyErrors();
      }
    }
  }

  function handleTooManyErrors() {
    dbg(`Muitos erros consecutivos (${consecutiveErrors}). Pausando por ${CONFIG.ERROR_COOLDOWN_MS}ms...`);
    setBanner(`Muitos erros. Pausando brevemente e tentando novamente...`);
    
    consecutiveErrors = 0;
    retryDelay = CONFIG.INITIAL_RETRY_DELAY_MS;
    
    setTimeout(() => {
      if (shouldBeRecording) {
        dbg("Retomando após cooldown...");
        setBanner("Retomando reconhecimento...");
        performSingleRestart();
      }
    }, CONFIG.ERROR_COOLDOWN_MS);
  }

  // ═══════════════════════════════════════════════════════════════════
  // WATCHDOG TIMER
  // ═══════════════════════════════════════════════════════════════════

  function startWatchdog() {
    if (watchdogInterval) return;
    
    touchWatchdog();
    
    watchdogInterval = setInterval(() => {
      if (!shouldBeRecording) return;
      
      const elapsed = Date.now() - lastEventTime;
      
      if (elapsed > CONFIG.WATCHDOG_TIMEOUT_MS) {
        dbg(`Watchdog: sem eventos há ${elapsed}ms. Forçando reinício...`);
        
        // Para instâncias atuais
        try {
          if (recognition && recognition._isStarted) recognition.abort();
        } catch (e) {}
        
        try {
          if (recognitionBackup && recognitionBackup._isStarted) recognitionBackup.abort();
        } catch (e) {}
        
        // Agenda reinício
        if (!isRestarting) {
          scheduleRestart(activeRecognition);
        }
      }
    }, CONFIG.WATCHDOG_CHECK_INTERVAL_MS);
  }

  function stopWatchdog() {
    if (watchdogInterval) {
      clearInterval(watchdogInterval);
      watchdogInterval = null;
    }
  }

  // ═══════════════════════════════════════════════════════════════════
  // VISIBILIDADE DA PÁGINA
  // ═══════════════════════════════════════════════════════════════════

  function handleVisibilityChange() {
    if (document.hidden) {
      dbg("Página oculta - reconhecimento pode ser afetado");
    } else {
      dbg("Página visível novamente");
      
      // Se deveria estar gravando, verifica estado
      if (shouldBeRecording) {
        const primaryOK = recognition && recognition._isStarted;
        const backupOK = recognitionBackup && recognitionBackup._isStarted;
        
        if (!primaryOK && !backupOK) {
          dbg("Nenhuma instância ativa após retorno. Reiniciando...");
          touchWatchdog();
          performSingleRestart();
        }
      }
    }
  }

  // ═══════════════════════════════════════════════════════════════════
  // API PÚBLICA
  // ═══════════════════════════════════════════════════════════════════

  function init() {
    const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
    
    if (!SpeechRecognition) {
      dbg("AVISO: Web Speech API não disponível neste navegador");
      setBanner("Seu navegador não suporta Web Speech API. Use Chrome, Edge ou Safari.");
      return false;
    }

    dbg("Web Speech API disponível - Modo robusto ativado");
    dbg(`Configurações: Watchdog=${CONFIG.WATCHDOG_TIMEOUT_MS}ms, Dual=${CONFIG.USE_DUAL_RECOGNITION}`);
    
    // Listener de visibilidade
    document.addEventListener("visibilitychange", handleVisibilityChange);
    
    emitTranscript();
    emitStatus();
    emitTimer();
    
    return true;
  }

  function start() {
    if (shouldBeRecording) {
      dbg("Já está gravando");
      return false;
    }

    // Verifica suporte
    const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SpeechRecognition) {
      setBanner("Web Speech API não suportada.");
      return false;
    }

    // Cria instância principal
    if (!recognition) {
      recognition = createRecognitionInstance("primary");
    }
    
    if (!recognition) {
      setBanner("Erro ao criar reconhecimento de voz.");
      return false;
    }

    // Cria instância de backup (dual recognition)
    if (CONFIG.USE_DUAL_RECOGNITION && !recognitionBackup) {
      recognitionBackup = createRecognitionInstance("backup");
    }

    shouldBeRecording = true;
    isRecording = true;
    startTime = Date.now();
    activeRecognition = "primary";
    
    // Inicia timer de UI
    if (timerInterval) clearInterval(timerInterval);
    timerInterval = setInterval(() => {
      emitTimer();
    }, 100);

    // Inicia watchdog
    startWatchdog();

    // Reseta estado de retry
    resetRetryState();

    try {
      recognition.start();
      setBanner("Gravação iniciada. Fale no microfone.");
      emitStatus();
      scheduleAutosave();
      return true;
    } catch (e) {
      dbg(`Erro ao iniciar: ${e}`);
      setBanner("Erro ao iniciar gravação.");
      shouldBeRecording = false;
      isRecording = false;
      emitStatus();
      return false;
    }
  }

  function stop() {
    if (!shouldBeRecording) return;

    dbg("Parando gravação...");
    
    shouldBeRecording = false;
    isRecording = false;
    
    // Cancela timeouts pendentes
    if (restartTimeout) {
      clearTimeout(restartTimeout);
      restartTimeout = null;
    }
    isRestarting = false;
    
    // Para watchdog
    stopWatchdog();
    
    // Para instâncias
    try {
      if (recognition && recognition._isStarted) recognition.abort();
    } catch (e) {}
    
    try {
      if (recognitionBackup && recognitionBackup._isStarted) recognitionBackup.abort();
    } catch (e) {}
    
    // Processa resultados pendentes
    if (resultDebounceTimer) {
      clearTimeout(resultDebounceTimer);
      resultDebounceTimer = null;
    }
    processBufferedResults();
    
    // Para timer
    if (timerInterval) {
      clearInterval(timerInterval);
      timerInterval = null;
    }

    currentPartial = "";
    emitPartial();
    emitStatus();
    emitTimer();
    scheduleAutosave();
    
    setBanner("Gravação parada.");
  }

  function clearTranscript() {
    transcribedAll = "";
    nLines = 0;
    currentPartial = "";
    pendingFinals = [];
    emitPartial();
    emitTranscript();
    scheduleAutosave();
  }

  function setTranscriptHtml(html) {
    transcribedAll = html || "";
  }

  function getTranscriptHtml() {
    return transcribedAll;
  }

  function getNLines() {
    return nLines;
  }

  function setNLines(v) {
    const n = Number(v);
    if (Number.isFinite(n) && n >= 0) nLines = n;
  }

  function getLanguage() {
    if (recognition) return recognition.lang;
    return (getLanguageOpt && getLanguageOpt()) || "pt-BR";
  }

  function setLanguage(lang) {
    const newLang = lang === "pt" ? "pt-BR" : "en-US";
    
    if (recognition) recognition.lang = newLang;
    if (recognitionBackup) recognitionBackup.lang = newLang;
    
    dbg(`Idioma alterado para: ${newLang}`);
  }

  // Cleanup quando o componente for destruído
  function destroy() {
    stop();
    document.removeEventListener("visibilitychange", handleVisibilityChange);
    recognition = null;
    recognitionBackup = null;
  }

  return {
    init,
    start,
    stop,
    clearTranscript,
    setTranscriptHtml,
    getTranscriptHtml,
    getNLines,
    setNLines,
    getLanguage,
    setLanguage,
    destroy,
  };
}