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

  /*
   * O preço, lido do produto.
   *
   * Desde 2026-09-18 a equipe muda preço pelo console da plataforma, e esta página é HTML
   * estático noutro domínio: sem isto ela anunciaria para sempre o preço do dia em que foi
   * publicada. Quem responde é o Next (`/api/planos`), e não o gateway — a borda não
   * publica a API (ver `infra/Caddyfile`).
   *
   * **O número do HTML é a reserva, e não um enfeite.** Falha de rede, API fora do ar ou
   * navegador sem `fetch` deixam a página exatamente como está — que é o preço padrão do
   * catálogo, conferido contra este arquivo por `frontend/src/lib/landing-plans.test.ts`.
   * Nada aqui esconde ou esvazia o que já está na tela.
   */
  function reais(cents) {
    return (cents / 100).toLocaleString('pt-BR')
  }

  function aplicarPrecos(itens) {
    itens.forEach(function (item) {
      var card = document.querySelector('[data-plan="' + item.plan + '"]')
      if (!card) return

      if (item.monthlyCents) {
        var val = card.querySelector('.price .val')
        if (val) val.textContent = reais(item.monthlyCents)
      }
      if (item.yearlyCents) {
        var ano = card.querySelector('[data-price-year] strong')
        if (ano) ano.textContent = 'R$ ' + reais(item.yearlyCents) + '/ano'
      }
    })
  }

  if (window.fetch) {
    fetch(appUrl + '/api/planos', { headers: { accept: 'application/json' } })
      .then(function (response) {
        return response.ok ? response.json() : null
      })
      .then(function (body) {
        if (body && Array.isArray(body.items)) aplicarPrecos(body.items)
      })
      .catch(function () {
        /* A reserva do HTML já está na tela. */
      })
  }

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
