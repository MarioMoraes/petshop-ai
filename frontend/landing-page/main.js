/*
 * PetShop AI — comportamento da landing page.
 *
 * Três coisas, e nenhuma é necessária para ler a página: sem JS os links continuam
 * funcionando (relativos), nada nasce escondido e o menu do celular só fica sem abrir.
 */
;(function () {
  'use strict'

  /*
   * Para onde vão "Entrar" e "Testar grátis".
   *
   * O Admin mora em `app.<domínio>` (ver `frontend/src/lib/host.ts`), então a página em
   * `petshop.ai` manda para `app.petshop.ai`. Em desenvolvimento o Next roda na 3002. A
   * meta `app-url` existe para quando nenhum dos dois palpites servir.
   */
  function resolveAppUrl() {
    var meta = document.querySelector('meta[name="app-url"]')
    var configured = meta && meta.content.trim()
    if (configured) return configured.replace(/\/+$/, '')

    var host = location.hostname
    if (!host || host === 'localhost' || host === '127.0.0.1' || location.protocol === 'file:') {
      return 'http://localhost:3002'
    }
    return location.protocol + '//app.' + host.replace(/^www\./, '')
  }

  var appUrl = resolveAppUrl()
  document.querySelectorAll('[data-app-path]').forEach(function (link) {
    link.setAttribute('href', appUrl + link.getAttribute('data-app-path'))
  })

  var year = document.querySelector('[data-year]')
  if (year) year.textContent = String(new Date().getFullYear())

  // ─── Navegação ────────────────────────────────────────────────────────────
  var nav = document.querySelector('.nav')
  var onScroll = function () {
    if (nav) nav.classList.toggle('is-scrolled', window.scrollY > 24)
  }
  window.addEventListener('scroll', onScroll, { passive: true })
  onScroll()

  var toggle = document.querySelector('.nav-toggle')
  var menu = document.getElementById('menu-movel')
  if (toggle && menu) {
    var setOpen = function (open) {
      menu.classList.toggle('is-open', open)
      toggle.setAttribute('aria-expanded', String(open))
      toggle.setAttribute('aria-label', open ? 'Fechar menu' : 'Abrir menu')
    }
    toggle.addEventListener('click', function () {
      setOpen(!menu.classList.contains('is-open'))
    })
    menu.addEventListener('click', function (event) {
      if (event.target.closest('a')) setOpen(false)
    })
    document.addEventListener('keydown', function (event) {
      if (event.key === 'Escape') setOpen(false)
    })
  }

  // ─── Entrada por rolagem ──────────────────────────────────────────────────
  var items = document.querySelectorAll('.reveal')
  if (!('IntersectionObserver' in window)) {
    items.forEach(function (el) {
      el.classList.add('is-visible')
    })
    return
  }

  var observer = new IntersectionObserver(
    function (entries) {
      entries.forEach(function (entry) {
        if (!entry.isIntersecting) return
        entry.target.classList.add('is-visible')
        observer.unobserve(entry.target)
      })
    },
    { rootMargin: '0px 0px -60px 0px', threshold: 0 },
  )

  items.forEach(function (el) {
    observer.observe(el)
  })
})()
