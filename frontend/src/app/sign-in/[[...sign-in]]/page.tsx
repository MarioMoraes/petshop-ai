import { SignIn } from '@clerk/nextjs'
import { Logo } from '@/components/ui'

export default function SignInPage() {
  return (
    <main className="flex min-h-[100svh] flex-col items-center justify-center gap-8 px-4">
      <Logo />
      <SignIn />
    </main>
  )
}
