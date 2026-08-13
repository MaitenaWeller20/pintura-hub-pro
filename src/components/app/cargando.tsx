/**
 * Lo que se ve mientras la app resuelve la sesión.
 *
 * Es el placeholder que el servidor dibuja para las rutas con `ssr: false` y el
 * mismo que usa el cliente mientras espera. Que sean el MISMO componente no es
 * un detalle: si el servidor manda un árbol y el cliente pinta otro, React
 * descarta todo y lo vuelve a dibujar (error de hidratación #418), que se ve
 * como un parpadeo al entrar.
 *
 * Tiene que ser neutro —nada donde tipear ni botones— porque al pasar del
 * placeholder al componente real React lo REMONTA. Si acá hubiera un
 * formulario, lo que la persona ya escribió se borraría solo.
 */
export function Cargando() {
  return (
    <div className="min-h-screen flex items-center justify-center text-muted-foreground">
      Cargando…
    </div>
  );
}
