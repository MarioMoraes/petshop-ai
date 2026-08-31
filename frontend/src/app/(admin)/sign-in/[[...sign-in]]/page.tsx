import { SignIn } from '@clerk/nextjs'
import { AuthSplit } from '@/components/auth-split'

export default function SignInPage() {
  return (
    <main>
      <AuthSplit chamada="Entre para continuar de onde parou.">
        <SignIn />
      </AuthSplit>
    </main>
  )
}
