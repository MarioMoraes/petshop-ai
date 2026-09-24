'use client'

import { useRef, useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { SITE_PHOTO_LIMIT, SITE_PHOTO_MAX_BYTES, type SitePhoto } from '@petshop/shared-types'
import { Alert, Button, Card, EmptyState, FormError, SectionHead } from '@/components/ui'
import { AlertTriangleIcon, ImageIcon } from '@/components/icons'
import { deleteSitePhotoAction, updateSitePhotoAction, uploadSitePhotoAction } from '../actions'

/**
 * A galeria (MOD-SITE-04).
 *
 * O aviso sobre foto de pet de cliente fica **no formulário de envio**, e não num link
 * de ajuda: é ali que a decisão é tomada. O sistema não guarda essa autorização — ela
 * é responsabilidade do estabelecimento, e a origem da foto é upload novo, nunca o
 * álbum do pet (AC-03): reaproveitá-lo transformaria consentimento de guarda em
 * consentimento de publicação, que são coisas diferentes.
 */

export function GalleryManager({ photos }: { photos: SitePhoto[] }) {
  const router = useRouter()
  const inputRef = useRef<HTMLInputElement>(null)
  const [error, setError] = useState<string | null>(null)
  const [pending, startTransition] = useTransition()

  const hero = photos.find((photo) => photo.kind === 'HERO')
  const full = photos.length >= SITE_PHOTO_LIMIT

  function upload(file: File) {
    setError(null)

    // A checagem no cliente é cortesia, não garantia: o parser do serviço recusa o
    // arquivo grande antes de ele ocupar memória. Aqui só evita a subida inútil.
    if (file.size > SITE_PHOTO_MAX_BYTES) {
      setError('Imagem acima de 8 MB. Reduza o arquivo e tente de novo.')
      return
    }

    // O `kind` não vai: quem decide que a primeira foto é a capa é o serviço, para
    // que a regra valha por qualquer caminho e não só por esta tela.
    const form = new FormData()
    form.append('file', file)

    startTransition(async () => {
      const result = await uploadSitePhotoAction(form)
      if (!result.ok) {
        setError(result.message)
        return
      }
      router.refresh()
    })
  }

  function update(id: string, patch: { alt?: string | null; kind?: 'HERO' | 'GALLERY' }) {
    setError(null)
    startTransition(async () => {
      const result = await updateSitePhotoAction(id, patch)
      if (!result.ok) {
        setError(result.message)
        return
      }
      router.refresh()
    })
  }

  function remove(id: string) {
    setError(null)
    startTransition(async () => {
      const result = await deleteSitePhotoAction(id)
      if (!result.ok) {
        setError(result.message)
        return
      }
      router.refresh()
    })
  }

  return (
    <div className="space-y-6">
      <FormError message={error} />

      <Card tone="soft" className="space-y-5">
        <SectionHead
          icon={<ImageIcon />}
          tone="icon-metric"
          eyebrow="Galeria"
          title="Enviar uma foto"
          description={`${photos.length} de ${SITE_PHOTO_LIMIT} fotos. JPG, PNG ou WEBP de até 8 MB.`}
        />

        <Alert
          tone="accent"
          icon={<AlertTriangleIcon />}
          title="Foto de pet de cliente exige autorização do tutor"
          role="status"
        >
          Publicar a imagem de um animal atendido é diferente de guardá-la no prontuário. Peça a
          autorização antes de subir — o sistema não a registra por você.
        </Alert>

        <div className="flex flex-wrap items-center gap-3">
          <input
            ref={inputRef}
            type="file"
            accept="image/jpeg,image/png,image/webp"
            className="hidden"
            onChange={(event) => {
              const file = event.target.files?.[0]
              if (file) upload(file)
              event.target.value = ''
            }}
          />
          <Button
            type="button"
            busy={pending}
            disabled={full}
            onClick={() => inputRef.current?.click()}
            busyLabel="Enviando…"
          >
            Escolher imagem
          </Button>
          {full && <p className="hint">Remova uma foto antes de subir outra.</p>}
        </div>
      </Card>

      {photos.length === 0 ? (
        <EmptyState
          icon={<ImageIcon />}
          tone="icon-metric"
          title="Nenhuma foto ainda"
          description="A página funciona sem foto, mas quem chega nela decide em segundos — e uma imagem do salão ajuda mais que qualquer texto."
        />
      ) : (
        <Card className="space-y-4">
          <ul className="grid gap-4 sm:grid-cols-2">
            {photos.map((photo) => (
              <li key={photo.id} className="rounded-2xl border border-line p-3">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                  src={photo.url}
                  alt={photo.alt ?? ''}
                  className="aspect-video w-full rounded-xl bg-shell object-contain"
                />

                <label className="mt-3 block">
                  <span className="label">Descrição da imagem</span>
                  <input
                    className="field"
                    maxLength={120}
                    defaultValue={photo.alt ?? ''}
                    placeholder="Sala de banho com secador"
                    disabled={pending}
                    onBlur={(event) => {
                      const next = event.target.value.trim()
                      if (next === (photo.alt ?? '').trim()) return
                      update(photo.id, { alt: next === '' ? null : next })
                    }}
                  />
                  <span className="hint mt-1 block">
                    Lida por quem usa leitor de tela e pelo buscador.
                  </span>
                </label>

                <div className="mt-3 flex flex-wrap items-center justify-between gap-2">
                  {photo.kind === 'HERO' ? (
                    <span className="hint">Foto de capa</span>
                  ) : (
                    <Button
                      type="button"
                      busy={pending}
                      onClick={() => {
                        // Uma capa só: a antiga volta para a galeria no mesmo gesto.
                        if (hero) update(hero.id, { kind: 'GALLERY' })
                        update(photo.id, { kind: 'HERO' })
                      }}
                      busyLabel="Salvando…"
                    >
                      Usar como capa
                    </Button>
                  )}

                  <Button
                    type="button"
                    busy={pending}
                    onClick={() => remove(photo.id)}
                    busyLabel="Removendo…"
                  >
                    Remover
                  </Button>
                </div>
              </li>
            ))}
          </ul>
        </Card>
      )}
    </div>
  )
}
