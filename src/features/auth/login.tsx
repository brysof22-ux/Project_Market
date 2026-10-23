import { useRef, useState, type FormEvent } from 'react'
import { ArrowRight, Eye, EyeOff, LoaderCircle, LockKeyhole, Moon, ShoppingBag, Sun } from 'lucide-react'
import { Button } from '../../components/ui/button'
import { useAuth } from './context'

export function Login({ dark, toggleTheme }: { dark: boolean; toggleTheme: () => void }) {
  const { signIn, error, configurationError, retry } = useAuth()
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [visible, setVisible] = useState(false)
  const [busy, setBusy] = useState(false)
  const submitting = useRef(false)
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (submitting.current || configurationError) return
    submitting.current = true
    setBusy(true)
    try { await signIn(email, password) }
    finally { submitting.current = false; setBusy(false); setPassword('') }
  }
  return <main className="auth-page">
    <Button className="auth-theme" size="icon" variant="ghost" onClick={toggleTheme} aria-label={dark ? 'Cambiar a modo claro' : 'Cambiar a modo oscuro'}>{dark ? <Sun size={20} /> : <Moon size={20} />}</Button>
    <div className="auth-container">
      <div className="brand auth-brand"><span className="brand-mark"><ShoppingBag size={25} strokeWidth={1.8} /></span><span>cai<span className="brand-light">market</span><small>GESTIÓN DE TIENDA</small></span></div>
      <section className="auth-card" aria-labelledby="login-title">
        <span className="auth-lock"><LockKeyhole size={23} strokeWidth={1.7} /></span>
        <h1 id="login-title">Bienvenido a tu tienda</h1>
        <p className="auth-subtitle">Inicia sesión para acceder a tu espacio de trabajo.</p>
        <form onSubmit={submit} className="auth-form" aria-busy={busy}>
          <label className="form-label" htmlFor="login-email">Correo electrónico</label>
          <input id="login-email" name="email" type="email" autoComplete="username" autoCapitalize="none" spellCheck={false} required maxLength={254} placeholder="tu@correo.com" value={email} onChange={(event) => setEmail(event.target.value)} disabled={busy} />
          <label className="form-label" htmlFor="login-password">Contraseña</label>
          <div className="auth-password"><input id="login-password" name="password" type={visible ? 'text' : 'password'} autoComplete="current-password" required value={password} onChange={(event) => setPassword(event.target.value)} disabled={busy} /><Button type="button" variant="ghost" size="icon" aria-label={visible ? 'Ocultar contraseña' : 'Mostrar contraseña'} aria-pressed={visible} onClick={() => setVisible(!visible)}>{visible ? <EyeOff size={17} /> : <Eye size={17} />}</Button></div>
          {(error || configurationError) && <div className="auth-error" role="alert">{configurationError || error}</div>}
          <Button type="submit" className="auth-submit" disabled={busy || !!configurationError}>{busy ? <><LoaderCircle size={17} className="animate-spin" /> Iniciando sesión…</> : <>Iniciar sesión <ArrowRight size={17} /></>}</Button>
          {error && !configurationError && <Button type="button" variant="ghost" onClick={retry}>Volver a comprobar sesión</Button>}
        </form>
        <p className="auth-help">¿Necesitas acceso? Contacta al administrador de tu tienda.</p>
      </section>
      <p className="auth-footer">CAI Market · Hecho para tu negocio</p>
    </div>
  </main>
}
