(() => {
  "use strict";

  const $ = (selector, scope = document) => scope.querySelector(selector);
  const $$ = (selector, scope = document) => [...scope.querySelectorAll(selector)];
  const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  const isMac = /Macintosh|Mac OS X|MacIntel|Darwin/i.test(navigator.userAgent);
  const isLinux = /Linux/i.test(navigator.userAgent) && !/Android/i.test(navigator.userAgent);
  const detectedDownload = isMac
    ? { label: "Download for macOS", url: "https://sparky.llc/get?platform=macos" }
    : isLinux
      ? { label: "Download for Linux", url: "https://sparky.llc/get?platform=linux" }
      : { label: "Download for Windows", url: "https://sparky.llc/get?platform=windows" };
  $$('[data-system-download]').forEach((link) => {
    link.href = detectedDownload.url;
    const label = $('[data-download-label]', link);
    if (label) label.textContent = detectedDownload.label;
  });

  const header = $("#site-header");
  const progress = $(".scroll-progress span");
  const updateScroll = () => {
    header?.classList.toggle("scrolled", window.scrollY > 18);
    const max = document.documentElement.scrollHeight - innerHeight;
    if (progress) progress.style.width = `${max > 0 ? (window.scrollY / max) * 100 : 0}%`;
  };
  updateScroll();
  addEventListener("scroll", updateScroll, { passive: true });

  const menuButton = $(".menu-button");
  menuButton?.addEventListener("click", () => {
    const open = document.body.classList.toggle("menu-open");
    menuButton.setAttribute("aria-expanded", String(open));
    const icon = $(".material-symbols-rounded", menuButton);
    if (icon) icon.textContent = open ? "close" : "menu";
  });
  $$(".primary-nav a").forEach((link) => link.addEventListener("click", () => {
    document.body.classList.remove("menu-open");
    menuButton?.setAttribute("aria-expanded", "false");
    const icon = menuButton && $(".material-symbols-rounded", menuButton);
    if (icon) icon.textContent = "menu";
  }));

  $$("[data-scroll-to]").forEach((button) => button.addEventListener("click", () => {
    $(button.dataset.scrollTo)?.scrollIntoView({ behavior: reducedMotion ? "auto" : "smooth" });
  }));

  const revealItems = $$(".reveal:not(.is-visible)");
  if ("IntersectionObserver" in window) {
    const revealObserver = new IntersectionObserver((entries) => {
      entries.forEach((entry) => {
        if (!entry.isIntersecting) return;
        entry.target.classList.add("is-visible");
        revealObserver.unobserve(entry.target);
      });
    }, { threshold: 0.12, rootMargin: "0px 0px -8%" });
    revealItems.forEach((element) => revealObserver.observe(element));
  } else {
    revealItems.forEach((element) => element.classList.add("is-visible"));
  }

  if (!reducedMotion && matchMedia("(pointer:fine)").matches) {
    const canvas = $("#trail-canvas");
    const context = canvas?.getContext("2d");
    if (!canvas || !context) return;
    const points = [];
    let dpr = Math.min(devicePixelRatio || 1, 2);
    const resize = () => {
      dpr = Math.min(devicePixelRatio || 1, 2);
      canvas.width = innerWidth * dpr;
      canvas.height = innerHeight * dpr;
      canvas.style.width = `${innerWidth}px`;
      canvas.style.height = `${innerHeight}px`;
      context.setTransform(dpr, 0, 0, dpr, 0, 0);
    };
    resize();
    addEventListener("resize", resize);
    addEventListener("pointermove", (event) => {
      const now = performance.now();
      points.push({ x: event.clientX, y: event.clientY, born: now, hue: (event.clientX / innerWidth) * 80 + 190 });
      if (points.length > 42) points.splice(0, points.length - 42);
    }, { passive: true });
    const drawTrail = (now) => {
      context.clearRect(0, 0, innerWidth, innerHeight);
      for (let index = points.length - 1; index >= 0; index -= 1) {
        const point = points[index];
        const age = now - point.born;
        if (age > 760) {
          points.splice(index, 1);
          continue;
        }
        const life = 1 - age / 760;
        context.beginPath();
        context.arc(point.x, point.y, 1.2 + life * 4.2, 0, Math.PI * 2);
        context.fillStyle = `hsla(${point.hue}, 92%, 60%, ${life * 0.35})`;
        context.shadowBlur = 18 * life;
        context.shadowColor = `hsla(${point.hue}, 100%, 60%, ${life * 0.5})`;
        context.fill();
      }
      context.shadowBlur = 0;
      requestAnimationFrame(drawTrail);
    };
    requestAnimationFrame(drawTrail);
  }
})();
