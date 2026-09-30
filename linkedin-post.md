# Jev (TypeSafe AI) — post para LinkedIn

> Cifras y API verificadas contra el launch post oficial de TypeSafe AI (15 sep 2026),
> su referencia HTTP y ambos SDK oficiales.

---

Toda nuestra infraestructura de IA está construida sobre una ecuación que nunca se escribió:

**IA = texto.**

Chat, párrafos redactados, y después un `JSON.parse()` con un regex esperanzado.

El 15 de septiembre, TypeSafe AI publicó **Jev**, un modelo que rompe esa ecuación deliberadamente. No genera ni una palabra. Y, curiosamente, esa es exactamente la razón por la que puede usarse dentro de un sistema en producción.

---

## El problema que casi nadie está midiendo

El uso más común de un LLM de frontera en una empresa no es creativo. Es **de clasificación**: enrutar un ticket, decidir si un documento es sensible, elegir el equipo, priorizar, filtrar spam, validar si un lead encaja en el ICP.

Para eso, la arquitectura estándar es absurda en coste:

1. Le mandas el estado.
2. Le pides que responda **en texto**.
3. Lees ese texto y rezas para que el formato sea válido.
4. Si no lo es: reintento, validación, o un `try/except` que se traga el incidente.

Ese bucle de parseo no es un detalle de implementación: es la superficie de fallo más común en producción. El modelo devuelve algo no parseable, tu pipeline se rompe, y además **pagaste tokens de entrada y de salida** por descubrir que un string no era JSON.

Mientras tanto, la tarea era binaria. Un `if` la resolvía.

---

## Jev: un modelo de decisiones, no un LLM conversacional

Jev es el primer **System One Model** de TypeSafe AI: una clase de modelo pensada para el pensamiento rápido e intuitivo, en la línea de *Thinking, Fast and Slow* de Kahneman. El nombre viene de William Stanley Jevons, cuya intuición era exactamente esta: cada orden de magnitud que baja el coste de la inteligencia desbloquea un orden de magnitud de casos de uso nuevos.

La frase del lanzamiento resume el producto entero:

> *Unstructured state in, typed probabilistic decisions out.*

No hay system prompt, ni `temperature`, ni `max_tokens`, ni streaming. Hay un endpoint, `POST /v1/systemone`, y hace una sola cosa.

### Las tres primitivas

Toda decisión que le pidas a Jev tiene que caber en una de estas tres formas:

| Primitiva | Pregunta | Devuelve |
|---|---|---|
| **Choice** | ¿Cuál de estas opciones? | `choice`, `probabilities`, `confidence` |
| **Score** | ¿En qué nivel de esta escala? | `score`, `legend`, `probabilities`, `confidence` |
| **Noul** | ¿Es esto cierto? | `noul` (0 a 1) |

Tres apuntes que separan esto de "usar un LLM con JSON mode":

- **Choice** y **Score** devuelven siempre `confidence`, calibrada, además de la distribución completa de probabilidades. `choice` es solo el `argmax`; lo accionable es lo que hay debajo.
- **Score** es una puntuación ponderada por probabilidad, así que puede caer **entre niveles** (un 1.6 en una escala de 0 a 3 es una respuesta legítima, no un bug).
- **Noul** no lleva campo `confidence`: la probabilidad *es* la señal. Un 0.5 significa "el modelo no tiene ni idea", no "el punto medio". Si lo que quieres es una posición en un espectro, quieres un Score.

Y lo importante: **todas las preguntas de una request se evalúan en paralelo, en un solo viaje**. No encadenes llamadas para "partir" una decisión; eso es lo que haces cuando cada llamada cuesta segundos.

---

## El código: umbrales en tu repo, no en el prompt

```python
from typesafe_sdk import Choice, Score, Noul, TypeSafeClient

client = TypeSafeClient()  # lee TYPESAFE_API_KEY del entorno

result = client.system_one(
    state={
        "subject": "Me han cobrado dos veces el mismo pedido",
        "body": "Hola, llevo tres días sin respuesta y me vuelven a cobrar...",
        "policy_ref": "refund_policy_v4",
    },
    questions={
        "route": Choice(
            instructions="¿Qué equipo debe gestionar este ticket?",
            criteria={
                "billing": "Pagos, reembolsos y facturas",
                "technical": "Fallos de integración o del producto",
                "account": "Acceso, login y permisos",
            },
        ),
        "severity": Score(
            instructions="¿Qué gravedad tiene este caso?",
            criteria=[
                "Sin impacto para el cliente",
                "Molesto, con alternativa",
                "Bloquea la operación del cliente",
                "Riesgo de pérdida de cliente o incumplimiento",
            ],
        ),
        "needs_human": Noul(
            instructions="¿Requiere intervención humana inmediata?",
        ),
    },
)

route = result.answers["route"]

# La confianza es lo que decide si te puedes permitir automatizar
if route.confidence >= 0.85:
    ticket.auto_assign(route.choice)      # dato puro, cero parseo
    ticket.set_priority(result.answers["severity"].score)
else:
    ticket.escalate_to_human()            # y te ahorras el LLM caro
```

En Node.js es lo mismo, con inferencia de tipos para que `res.answers.route.choice` compile y `.noul` sea un error de TypeScript:

```ts
import { TypeSafeClient, choice, noul } from "@typesafe-ai/sdk";

const jev = new TypeSafeClient();

const res = await jev.systemOne({
  state: ticket,
  questions: {
    route: choice("¿Qué equipo debe gestionar este ticket?", {
      billing: "Pagos, reembolsos y facturas",
      technical: "Fallos de integración",
      account: "Acceso y login",
    }),
    escalate: noul("¿Requiere intervención humana inmediata?"),
  },
});

if (res.answers.route.confidence > 0.85) {
  await autoAssign(res.answers.route.choice);
} else {
  await escalateToHuman();
}
```

Fíjate en lo que ha desaparecido: el schema, el parser, el retry, el prompt que defensivamente dice "responde solo con JSON válido", y el `confidence` del LLM que "más o menos" funcionaba.

Lo que queda es un **`if` con un umbral explícito, versionado en tu repositorio**. Eso es auditable, testeable y revisable en un pull request.

---

## Por qué esto cambia la economía del pipeline

|  | LLM de frontera | Jev |
|---|---|---|
| Coste de entrada | $0.20 – $10 / MTok | **$0.042 / MTok** |
| Coste de salida | ~5x la entrada | **Gratis** |
| Latencia end-to-end | 3 – 329 s | **70 – 500 ms** |
| Salida | String libre, hay que parsear | Valor tipado, nunca un type error |

Dos consecuencias prácticas.

**Primera: se cae la barrera de la latencia.** Con 70–500 ms, la decisión deja de ser una llamada bloqueante y pasa a ser una decisión *síncrona dentro de tu request HTTP*. Eso habilita arquitecturas que antes eran impensables por coste: gatear cada petición, cada fila de un batch, cada paso de un agente.

**Segunda: cambia la economía del volumen.** A $0.042 por millón de tokens de entrada, procesar un millón de tickets cuesta alrededor de cuatro dólares. Eso no es un proyecto de R&D que necesita aprobación de presupuesto: es una factura. A esa escala la pregunta deja de ser "¿es fiable?" y pasa a ser "¿cómo no estoy ya haciendo esto?".

---

## Los límites, porque existen

Un post que solo vende no es un post de arquitecto:

- **No genera texto.** Nada de redacción, resúmenes, RAG, respuesta a clientes o generación de código. Si tu caso necesita una frase que leer, Jev no es el modelo.
- **La latencia de 70–500 ms viene del blog de lanzamiento**, no de la documentación: no hay SLA, ni percentiles, ni regiones.
- **La calibración depende de tu dataset.** Antes de fijar un umbral de 0.85, mide el error de calibración con tus propios datos. Es el único número que cuenta.
- **Solo texto.** Sin imágenes, audio ni vídeo por ahora.
- **Alta cardinalidad cuesta.** Con muchas opciones en un `choice` el muestreo pasa a dos etapas y aparece latencia ocasional.

---

## El futuro no es un modelo. Son dos

No se trata de reemplazar los LLMs conversacionales. Se trata de dejar de usarlos para decidir.

La arquitectura madura de los próximos dos años va a ser explícitamente **híbrida**, y va a tener esta forma:

- **Un System One model decide.** Rápido, tipado, calibrado y a céntimos. Es el gate.
- **Un LLM conversacional redacta.** Solo cuando de verdad hay que *escribir* algo, y únicamente si el gate ha pasado.

Es la separación entre **inferir** y **expresar**, que hasta ahora vivían amontonados en el mismo modelo.

La consecuencia organizativa importa tanto como la técnica: mientras la decisión vive dentro de un prompt, es deuda técnica que nadie puede testear. En el momento en que es una llamada tipada con un umbral en tu código, **se testea, se versiona y se revisa**. Eso no es una mejora de calidad: es un cambio de categoría en cómo se construye software.

Mi lectura: el salto real no es que Jev sea más rápido. Es que hace **decidible** algo que hasta ahora era inauditable.

---

**¿Cuál es esa decisión en tu sistema que hoy resuelves con un prompt, un regex y una esperanza?**

Os leo.

\#AI #SoftwareArchitecture #LLM #MLOps #EngineeringLeadership