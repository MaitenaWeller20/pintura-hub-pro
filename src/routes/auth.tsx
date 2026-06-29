import { createFileRoute, redirect } from "@tanstack/react-router";
import { useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card } from "@/components/ui/card";
import { Paintbrush, Loader2 } from "lucide-react";
import { toast } from "sonner";
import { useServerFn } from "@tanstack/react-start";
import { seedInitialUsers } from "@/lib/setup.functions";

export const Route = createFileRoute("/auth")({
  ssr: false,
  beforeLoad: async () => {
    const { data } = await supabase.auth.getUser();
    if (data.user) throw redirect({ to: "/" });
  },
  component: AuthPage,
});

function AuthPage() {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [loading, setLoading] = useState(false);
  const [seeding, setSeeding] = useState(false);
  const seedFn = useServerFn(seedInitialUsers);

  const onSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    const { error } = await supabase.auth.signInWithPassword({ email: email.trim(), password });
    setLoading(false);
    if (error) {
      toast.error("Credenciales inválidas o cuenta inactiva.");
      return;
    }
    toast.success("Bienvenido/a");
    window.location.href = "/";
  };

  const onSeed = async () => {
    setSeeding(true);
    try {
      const r = await seedFn();
      toast.success(`Usuarios listos (${r.results.filter((x) => x.status === "creado").length} nuevos)`);
    } catch (e: any) {
      toast.error(e.message ?? "Error inicializando usuarios");
    } finally {
      setSeeding(false);
    }
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
              <Input id="email" type="email" autoComplete="username" required
                value={email} onChange={(e) => setEmail(e.target.value)} placeholder="usuario@casaforma.com" />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="password">Contraseña</Label>
              <Input id="password" type="password" autoComplete="current-password" required
                value={password} onChange={(e) => setPassword(e.target.value)} />
            </div>
            <Button type="submit" className="w-full" disabled={loading}>
              {loading && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              Ingresar
            </Button>
          </form>
        </Card>

        <div className="mt-6 text-center text-xs text-muted-foreground space-y-2">
          <p>Primera vez usando el sistema? Inicializá los usuarios precargados:</p>
          <Button variant="outline" size="sm" onClick={onSeed} disabled={seeding}>
            {seeding && <Loader2 className="mr-2 h-3 w-3 animate-spin" />}
            Crear usuarios iniciales
          </Button>
          <div className="mt-4 text-left bg-muted/40 p-3 rounded text-[11px] leading-relaxed">
            <strong>Usuarios precargados:</strong><br />
            • Admin: <code>maitenaweller2004@gmail.com</code> / <code>admin1234</code><br />
            • O'Higgins 1: <code>silvia@casa-forma.com</code> / <code>emp1234</code><br />
            • O'Higgins 2: <code>ohiggins2@casaforma.local</code> / <code>emp1234</code><br />
            • Gral. Paz 1: <code>generalpaz1@casaforma.local</code> / <code>emp1234</code><br />
            • Gral. Paz 2: <code>generalpaz2@casaforma.local</code> / <code>emp1234</code>
          </div>
        </div>
      </div>
    </div>
  );
}
