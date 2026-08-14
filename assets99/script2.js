const root = document.documentElement;
root.classList.remove("no-js");

const body = document.body;
const scene = document.querySelector("#scroll-cinema");
const videoForward = document.querySelector("#scroll-video-forward");
const videoBackward = document.querySelector("#scroll-video-backward");
const panels = Array.from(document.querySelectorAll(".copy-panel"));
const progressLine = document.querySelector("#progress-line");
const videoState = document.querySelector("#video-state");
const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

// Состояния для двух видео
let duration = 0;
let targetProgress = 0;
let smoothProgress = 0;
let isReady = false;
let lastVideoTime = -1;
let lastSeekAt = 0;
let lastFrameAt = 0;
let rafId = 0;
let fallbackIntervalId = 0;
let warmAttempted = false;
let playPromise = null;
let seekFallback = false;
let activeVideo = null;
let lastDirection = 0;
let videosReady = { forward: false, backward: false };
let videoDurations = { forward: 0, backward: 0 };
let switchTimeout = null;
let isSwitching = false;

const clamp = (value, min = 0, max = 1) => Math.min(max, Math.max(min, value));
const lerp = (start, end, amount) => start + (end - start) * amount;
const noBreakWords = new Set([
  "а", "в", "во", "до", "за", "из", "и", "к", "ко",
  "на", "не", "но", "о", "об", "от", "по", "с", "со",
  "у", "без", "для", "или", "как", "над", "под", "при", "про"
]);

function addNoBreaks(text) {
  let result = text;
  for (let index = 0; index < 2; index += 1) {
    result = result.replace(/(^|[\s([{"«„])([А-Яа-яЁё]{1,3})\s+/g, (match, prefix, word) => {
      return noBreakWords.has(word.toLowerCase()) ? `${prefix}${word}\u00a0` : match;
    });
  }
  return result;
}

function applyTextTypography() {
  document.querySelectorAll(".copy-panel h1, .copy-panel h2, .copy-panel .lead, .copy-panel .button").forEach((element) => {
    element.childNodes.forEach((node) => {
      if (node.nodeType === Node.TEXT_NODE) {
        node.textContent = addNoBreaks(node.textContent);
      }
    });
  });
}

function splitHeadingWords() {
  document.querySelectorAll(".copy-panel h1, .copy-panel h2").forEach((heading) => {
    if (heading.querySelector(".word-mask")) return;

    const sourceText = heading.textContent.trim();
    const words = sourceText.split(/[ \t\r\n]+/).filter(Boolean);
    heading.setAttribute("aria-label", sourceText);
    heading.textContent = "";

    words.forEach((wordText, index) => {
      const mask = document.createElement("span");
      const word = document.createElement("span");
      mask.className = "word-mask";
      word.className = "word";
      word.textContent = wordText;
      mask.appendChild(word);
      heading.appendChild(mask);
      if (index < words.length - 1) {
        heading.appendChild(document.createTextNode(" "));
      }
    });
  });
}

function splitLeadLines() {
  document.querySelectorAll(".copy-panel .lead").forEach((lead) => {
    if (!lead.dataset.sourceText) {
      lead.dataset.sourceText = addNoBreaks(lead.textContent.trim().replace(/\s+/g, " "));
    }

    const sourceText = lead.dataset.sourceText;
    const words = sourceText.split(/[ \t\r\n]+/).filter(Boolean);
    const measuredWords = [];

    lead.classList.remove("is-line-ready");
    lead.textContent = "";

    words.forEach((wordText, index) => {
      const word = document.createElement("span");
      word.className = "line-measure-word";
      word.textContent = wordText;
      lead.appendChild(word);
      measuredWords.push(word);
      if (index < words.length - 1) {
        lead.appendChild(document.createTextNode(" "));
      }
    });

    const lines = [];
    measuredWords.forEach((word) => {
      const top = Math.round(word.offsetTop);
      const currentLine = lines[lines.length - 1];
      if (!currentLine || currentLine.top !== top) {
        lines.push({ top, words: [word.textContent] });
      } else {
        currentLine.words.push(word.textContent);
      }
    });

    lead.textContent = "";
    lines.forEach((lineData) => {
      const mask = document.createElement("span");
      const line = document.createElement("span");
      mask.className = "line-mask";
      line.className = "line";
      line.textContent = lineData.words.join(" ");
      mask.appendChild(line);
      lead.appendChild(mask);
    });

    lead.classList.add("is-line-ready");
  });
}

function prepareTextAnimations() {
  splitHeadingWords();
  splitLeadLines();
}

function setRevealStyle(element, progress, fromY, unit = "%") {
  const value = clamp(progress);
  element.style.setProperty("--text-reveal-opacity", value.toFixed(3));
  element.style.setProperty("--text-reveal-y", `${lerp(fromY, 0, value).toFixed(2)}${unit}`);
}

function animatePanelText(panel, progress) {
  const words = Array.from(panel.querySelectorAll(".word"));
  const lines = Array.from(panel.querySelectorAll(".line"));

  words.forEach((word, index) => {
    const start = index * 0.085;
    const wordProgress = smootherstep(start, start + 0.42, progress);
    setRevealStyle(word, wordProgress, 112, "%");
  });

  lines.forEach((line, index) => {
    const start = 0.28 + index * 0.13;
    const lineProgress = smootherstep(start, start + 0.42, progress);
    setRevealStyle(line, lineProgress, 22, "px");
  });
}

function resetTextAnimations(panel) {
  panel.querySelectorAll(".word, .line").forEach((element) => {
    setRevealStyle(element, 1, 0);
  });
}

function smootherstep(edge0, edge1, value) {
  const x = clamp((value - edge0) / (edge1 - edge0));
  return x * x * x * (x * (x * 6 - 15) + 10);
}

function getSceneProgress() {
  const rect = scene.getBoundingClientRect();
  const scrollable = Math.max(1, rect.height - window.innerHeight);
  return clamp(-rect.top / scrollable);
}

function resetPanelStyles() {
  panels.forEach((panel) => {
    panel.style.opacity = "";
    panel.style.filter = "";
    panel.style.transform = "";
    panel.classList.add("is-visible");
    resetTextAnimations(panel);
  });
}

function setPanelStyles(progress) {
  panels.forEach((panel) => {
    const start = Number(panel.dataset.start);
    const end = Number(panel.dataset.end);
    const fade = Math.min(0.04, Math.max(0.028, (end - start) * 0.24));
    const enter = start <= 0 ? 1 : smootherstep(start, start + fade, progress);
    const exit = end >= 1 ? 1 : 1 - smootherstep(end - fade, end, progress);
    const opacity = clamp(enter * exit);
    const travelFrom = start <= 0 ? 0 : 24;
    const travel = lerp(travelFrom, -12, smootherstep(start, end, progress));
    const blur = lerp(8, 0, smootherstep(0, 0.42, opacity));
    const scale = lerp(0.985, 1, opacity);
    const textProgress = start <= 0 ? 1 : smootherstep(start, start + (end - start) * 0.48, progress);

    panel.style.opacity = opacity.toFixed(3);
    panel.style.filter = `blur(${blur.toFixed(2)}px)`;
    panel.style.transform = `translate3d(0, calc(var(--panel-anchor) + ${travel.toFixed(2)}px), 0) scale(${scale.toFixed(4)})`;
    panel.classList.toggle("is-visible", opacity > 0.48);
    animatePanelText(panel, textProgress);
  });
}

function setVideoError() {
  body.classList.add("video-failed");
  if (videoState) {
    videoState.textContent = "Video unavailable, showing poster";
  }
}

function getActiveVideo() {
  if (!activeVideo) {
    // Если активное видео не установлено, выбираем forward как default
    if (videoForward && videosReady.forward) {
      activeVideo = videoForward;
      videoForward.classList.add('active');
      duration = videoDurations.forward;
    } else if (videoBackward && videosReady.backward) {
      activeVideo = videoBackward;
      videoBackward.classList.add('active');
      duration = videoDurations.backward;
    }
  }
  return activeVideo;
}

function switchVideo(direction) {
  if (!videoForward || !videoBackward || isSwitching) return;
  
  // Отменяем предыдущий таймаут
  if (switchTimeout) {
    clearTimeout(switchTimeout);
    switchTimeout = null;
  }

  const newDirection = direction > 0 ? 'forward' : 'backward';
  const currentDirection = activeVideo === videoForward ? 'forward' : 
                          activeVideo === videoBackward ? 'backward' : null;
  
  // Если направление не изменилось или идет переключение
  if (newDirection === currentDirection || isSwitching) {
    return;
  }

  // Если новое видео не готово, ждем
  if (!videosReady[newDirection]) {
    switchTimeout = setTimeout(() => {
      switchVideo(direction);
    }, 50);
    return;
  }

  isSwitching = true;

  // Сохраняем текущий прогресс
  const currentProgress = smoothProgress;
  const targetDuration = videoDurations[newDirection];
  const targetTime = clamp(currentProgress) * Math.max(0.1, targetDuration - 0.08);

  const newVideo = newDirection === 'forward' ? videoForward : videoBackward;
  
  // Если это то же видео, выходим
  if (newVideo === activeVideo) {
    isSwitching = false;
    return;
  }

  // Останавливаем текущее видео
  if (activeVideo) {
    activeVideo.pause();
    activeVideo.classList.remove('active');
  }

  // Переключаем на новое видео
  const oldVideo = activeVideo;
  activeVideo = newVideo;
  activeVideo.classList.add('active');

  // Устанавливаем время с задержкой для плавного переключения
  try {
    if (typeof activeVideo.fastSeek === "function") {
      activeVideo.fastSeek(targetTime);
    } else {
      activeVideo.currentTime = targetTime;
    }
    lastVideoTime = targetTime;
    lastSeekAt = performance.now();
  } catch (error) {
    console.warn('Error seeking during switch:', error);
    try {
      activeVideo.currentTime = targetTime;
      lastVideoTime = targetTime;
    } catch (e) {
      console.error('Failed to seek:', e);
    }
  }

  // Обновляем длительность
  duration = videoDurations[newDirection];
  
  // Скрываем старое видео с задержкой для плавного перехода
  if (oldVideo) {
    setTimeout(() => {
      if (oldVideo !== activeVideo) {
        oldVideo.style.opacity = '0';
        // Через 50мс убираем z-index
        setTimeout(() => {
          oldVideo.style.zIndex = '0';
        }, 50);
      }
    }, 10);
  }

  // Даем новому видео высокий z-index
  activeVideo.style.zIndex = '2';
  activeVideo.style.opacity = '1';

  // Сбрасываем флаг переключения через небольшую задержку
  setTimeout(() => {
    isSwitching = false;
  }, 50);

  console.log(`🔄 Switched to ${newDirection} video at ${targetTime.toFixed(3)}s (progress: ${currentProgress.toFixed(3)})`);
}

function checkVideosReady() {
  // Проверяем оба видео
  if (videosReady.forward && videosReady.backward) {
    isReady = true;
    body.classList.remove("is-loading");
    
    // Активируем forward по умолчанию
    if (!activeVideo) {
      activeVideo = videoForward;
      videoForward.classList.add('active');
      videoForward.style.opacity = '1';
      videoForward.style.zIndex = '2';
      videoBackward.style.opacity = '0';
      videoBackward.style.zIndex = '1';
      duration = videoDurations.forward;
    }
    
    console.log('✅ Both videos ready');
    updateProgress();
    smoothProgress = targetProgress;
    syncVideo(targetProgress, true);
    return true;
  }
  
  // Если только одно видео готово
  if (videosReady.forward || videosReady.backward) {
    const direction = videosReady.forward ? 'forward' : 'backward';
    const video = direction === 'forward' ? videoForward : videoBackward;
    
    if (!isReady) {
      isReady = true;
      body.classList.remove("is-loading");
      activeVideo = video;
      video.classList.add('active');
      video.style.opacity = '1';
      video.style.zIndex = '2';
      duration = videoDurations[direction];
      console.log(`⚠️ Only ${direction} video ready`);
      updateProgress();
      smoothProgress = targetProgress;
      syncVideo(targetProgress, true);
      return true;
    }
  }
  
  return false;
}

function seekVideo(nextTime, force = false) {
  const video = getActiveVideo();
  if (!video) return;
  
  const now = performance.now();
  const minSeekGap = 1000 / 30;
  const timeDelta = Math.abs(nextTime - lastVideoTime);

  if (!force && timeDelta < 0.018) return;
  if (!force && now - lastSeekAt < minSeekGap && timeDelta < 0.12) return;
  if (!force && video.seeking && timeDelta < 0.18) return;

  try {
    if (typeof video.fastSeek === "function") {
      video.fastSeek(nextTime);
    } else {
      video.currentTime = nextTime;
    }
    lastVideoTime = nextTime;
    lastSeekAt = now;
  } catch (error) {
    setVideoError();
  }
}

function pauseVideo() {
  const video = getActiveVideo();
  if (!video || video.paused) return;
  video.pause();
}

function ensurePlaying(fallbackTime) {
  const video = getActiveVideo();
  if (!video || !video.paused || playPromise) return;

  playPromise = video.play();
  if (playPromise && typeof playPromise.then === "function") {
    playPromise
      .catch(() => {
        seekFallback = true;
        seekVideo(fallbackTime, true);
      })
      .finally(() => {
        playPromise = null;
      });
  } else {
    playPromise = null;
  }
}

function syncVideo(progress, force = false) {
  if (!isReady || !duration || reducedMotion) return;

  const video = getActiveVideo();
  if (!video) return;

  const safeDuration = Math.max(0.1, duration - 0.08);
  const targetTime = clamp(progress) * safeDuration;
  const currentTime = video.currentTime || 0;
  const delta = targetTime - currentTime;

  // Определяем направление и переключаем видео
  if (Math.abs(delta) > 0.002 && videosReady.forward && videosReady.backward && !isSwitching) {
    const direction = delta > 0 ? 1 : -1;
    if (direction !== lastDirection) {
      lastDirection = direction;
      switchVideo(direction);
      // После переключения выходим, синхронизация будет в следующем кадре
      if (isSwitching) return;
    }
  }

  // Синхронизация
  if (force || seekFallback) {
    pauseVideo();
    seekVideo(targetTime, true);
    return;
  }

  if (Math.abs(delta) < 0.035) {
    pauseVideo();
    return;
  }

  if (delta > 0) {
    if (delta > 0.7) {
      seekVideo(Math.max(0, targetTime - 0.18), true);
    }
    video.playbackRate = clamp(delta * 3.2, 0.45, 2.4);
    ensurePlaying(targetTime);
    return;
  }

  pauseVideo();
  seekVideo(targetTime);
}

function applyProgress(progress) {
  setPanelStyles(progress);
  if (progressLine) {
    progressLine.style.transform = `scaleX(${progress.toFixed(4)})`;
  }
}

function updateProgress() {
  targetProgress = getSceneProgress();
  applyProgress(targetProgress);
}

function tick(now = performance.now()) {
  targetProgress = getSceneProgress();

  if (!lastFrameAt) {
    lastFrameAt = now;
    smoothProgress = targetProgress;
  }

  const deltaSeconds = Math.min(0.05, Math.max(0.001, (now - lastFrameAt) / 1000));
  const smoothing = 1 - Math.exp(-deltaSeconds * 28);
  lastFrameAt = now;

  if (Math.abs(smoothProgress - targetProgress) < 0.0012) {
    smoothProgress = targetProgress;
  } else {
    smoothProgress = lerp(smoothProgress, targetProgress, smoothing);
  }

  syncVideo(smoothProgress);
  applyProgress(targetProgress);
}

function render(now = performance.now()) {
  tick(now);
  rafId = window.requestAnimationFrame(render);
}

async function warmVideo() {
  if (warmAttempted || reducedMotion) return;
  
  const video = getActiveVideo();
  if (!video) return;

  warmAttempted = true;
  try {
    video.muted = true;
    await video.play();
    video.pause();
  } catch (error) {
    if (video) video.pause();
  }
}

function enableStaticExperience() {
  body.classList.add("reduced-motion");
  body.classList.remove("is-loading");

  panels.forEach((panel) => {
    panel.style.opacity = "1";
    panel.style.filter = "none";
    panel.style.transform = "none";
    panel.classList.add("is-visible");
    resetTextAnimations(panel);
  });

  if (progressLine) {
    progressLine.style.transform = "scaleX(1)";
  }
  
  if (videoForward) {
    videoForward.classList.add('active');
    videoForward.style.opacity = '1';
  }
  if (videoBackward) {
    videoBackward.style.opacity = '0';
  }
}

function initializeVideos() {
  if (!videoForward || !videoBackward) {
    console.error('❌ Video elements not found');
    setVideoError();
    return;
  }

  body.classList.add("is-loading");

  // Инициализация стилей видео
  videoForward.style.opacity = '1';
  videoForward.style.zIndex = '1';
  videoBackward.style.opacity = '0';
  videoBackward.style.zIndex = '0';

  const setupVideo = (video, direction) => {
    const metadataHandler = () => {
      const dur = Number.isFinite(video.duration) ? video.duration : 0;
      videoDurations[direction] = dur;
      videosReady[direction] = dur > 0;
      video.preload = "auto";
      console.log(`📹 ${direction} video loaded: ${dur.toFixed(2)}s`);
      checkVideosReady();
    };
    
    const canplayHandler = () => {
      body.classList.remove("is-loading");
    };
    
    const errorHandler = (event) => {
      console.warn(`⚠️ Error loading ${direction} video:`, event);
      videosReady[direction] = false;
      body.classList.remove("is-loading");
      if (!videosReady.forward && !videosReady.backward) {
        setVideoError();
      }
      checkVideosReady();
    };
    
    video.addEventListener("loadedmetadata", metadataHandler, { once: true });
    video.addEventListener("canplay", canplayHandler, { once: true });
    video.addEventListener("error", errorHandler);
    
    // Если видео уже загружено
    if (video.readyState >= 1) {
      metadataHandler();
    }
  };

  setupVideo(videoForward, 'forward');
  setupVideo(videoBackward, 'backward');

  // Таймаут
  window.setTimeout(() => {
    if (!isReady && !reducedMotion) {
      body.classList.remove("is-loading");
      if (videosReady.forward || videosReady.backward) {
        const direction = videosReady.forward ? 'forward' : 'backward';
        const video = direction === 'forward' ? videoForward : videoBackward;
        isReady = true;
        activeVideo = video;
        video.classList.add('active');
        video.style.opacity = '1';
        video.style.zIndex = '2';
        duration = videoDurations[direction];
        console.log(`⏰ Timeout: using ${direction} video`);
        updateProgress();
        smoothProgress = targetProgress;
        syncVideo(targetProgress, true);
      } else {
        console.warn('⏰ Timeout: no videos ready');
        setVideoError();
      }
    }
  }, 3000);
}

// Инициализация
applyTextTypography();
prepareTextAnimations();

if (document.fonts && document.fonts.ready) {
  document.fonts.ready.then(() => {
    prepareTextAnimations();
    updateProgress();
  });
}

if (reducedMotion) {
  enableStaticExperience();
} else {
  initializeVideos();
  updateProgress();
  setPanelStyles(0);
  render();
  fallbackIntervalId = window.setInterval(() => tick(performance.now()), 1000 / 30);

  window.addEventListener("scroll", updateProgress, { passive: true });
  window.addEventListener("resize", () => {
    prepareTextAnimations();
    updateProgress();
    smoothProgress = targetProgress;
    syncVideo(smoothProgress, true);
  });
  window.addEventListener("orientationchange", () => {
    prepareTextAnimations();
    updateProgress();
    smoothProgress = targetProgress;
    syncVideo(smoothProgress, true);
  });
  
  const warmEvents = ["pointerdown", "touchstart", "wheel", "keydown"];
  warmEvents.forEach(event => {
    window.addEventListener(event, warmVideo, { once: true, passive: true });
  });
}

window.addEventListener("pagehide", () => {
  if (rafId) window.cancelAnimationFrame(rafId);
  if (fallbackIntervalId) window.clearInterval(fallbackIntervalId);
  if (switchTimeout) clearTimeout(switchTimeout);
});
