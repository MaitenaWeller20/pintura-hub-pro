import { createFileRoute, redirect } from "@tanstack/react-router";
import { useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card } from "@/components/ui/card";
import { Paintbrush, Loader2 } from "lucide-react";
import { toast } from "sonner";
import { Cargando } from "@/components/app/cargando";
import { perfilHabilitaSesion } from "@/hooks/use-current-user";

/**
 * La sesión vive en el navegador, así que esta ruta no se puede resolver en el
 * servidor: de ahí el `ssr: false`.
 *
 * El `pendingComponent` es lo que el servidor dibuja mientras tanto. Sin él
 * mandaba un Suspense vacío, el cliente pintaba el formulario encima y React
 * tiraba el error de hidratación #418: descarta el árbol y lo vuelve a dibujar,
 * que se ve como un parpadeo al entrar.
 *
 * Tiene que ser un placeholder NEUTRO, no el formulario. Se probaron las dos
 * alternativas y las dos son peores:
 *
 *   · Con el formulario de placeholder, al pasar del pendiente al componente
 *     React lo REMONTA y borra lo ya tipeado. Se vio el mail desaparecer
 *     mientras se completaba la contraseña.
 *   · Renderizándolo en el servidor (sacando `ssr: false`), el formulario
 *     aparece ANTES de que cargue el JavaScript: quien escribe rápido y aprieta
 *     Enter dispara un submit nativo del navegador que no hace nada. Con la
 *     suite de pruebas fallaban 15 de 27 por esto.
 *
 * Con un placeholder neutro no hay nada que tipear hasta que el formulario está
 * montado y funcionando.
 */
export const Route = createFileRoute("/auth")({
  ssr: false,
  beforeLoad: async () => {
    const { data } = await supabase.auth.getUser();
    if (data.user) throw redirect({ to: "/" });
  },
  component: AuthPage,
  pendingComponent: Cargando,
});

function AuthPage() {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [loading, setLoading] = useState(false);

  const onSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    const { data, error } = await supabase.auth.signInWithPassword({
      email: email.trim(),
      password,
    });
    if (error) {
      setLoading(false);
      toast.error("Credenciales inválidas o cuenta inactiva.");
      return;
    }
    const { data: perfil, error: perfilError } = await supabase
      .from("profiles")
      .select("activo")
      .eq("id", data.user.id)
      .maybeSingle();
    if (!perfilHabilitaSesion(perfil, perfilError)) {
      await supabase.auth.signOut();
      setLoading(false);
      toast.error("La cuenta no está activa. Contactá a un administrador.");
      return;
    }
    setLoading(false);
    toast.success("Bienvenido/a");
    window.location.href = "/";
  };

  return (
    <div className="min-h-screen flex items-center justify-center px-4 bg-gradient-to-br from-background via-background to-secondary">
      <div className="w-full max-w-md">
        <div className="flex flex-col items-center mb-8">
          <div className="h-14 w-14 rounded-2xl bg-primary flex items-center justify-center mb-3">
            <Paintbrush className="h-7 w-7 text-primary-foreground" />
          </div>
          <h1 className="text-3xl font-bold tracking-tight">PinturaGest</h1>
          <p className="text-sm text-muted-foreground">CasaForma · Gestión de sucursales</p>
        </div>

        <Card className="p-6">
          <form onSubmit={onSubmit} className="space-y-4">
            <div className="space-y-1.5">
              <Label htmlFor="email">Email</Label>
              <Input
                id="email"
                type="email"
                autoComplete="username"
                required
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="usuario@casaforma.com"
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="password">Contraseña</Label>
              <Input
                id="password"
                type="password"
                autoComplete="current-password"
                required
                value={password}
                onChange={(e) => setPassword(e.target.value)}
              />
            </div>
            <Button type="submit" className="w-full" disabled={loading}>
              {loading && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              Ingresar
            </Button>
          </form>
        </Card>

        <p className="mt-6 text-center text-xs text-muted-foreground">
          ¿No tenés acceso? Pedile a un administrador que te dé de alta desde Usuarios.
        </p>
      </div>
    </div>
  );
}
