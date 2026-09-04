# AGENTS.md

## Product

Build an accessible, client-only educational explorer for the homogeneous one-dimensional wave equation:

$$u_{tt}-u_{xx}=0,\qquad u(x,0)=f(x),\quad u_t(x,0)=g(x).$$

- The UI fixes wave speed to 1 and supports the infinite line, the left-bounded half-line, and a finite interval. Finite endpoints independently support time-dependent Dirichlet or Neumann data.
- Keep deployment static on GitHub Pages, with Vite `base: "./"`. No backend, accounts, or persistence are needed.
- Begin with a Gaussian displacement and zero velocity, paused at t=0. Accepted problem changes and Restart return to paused t=0; only explicit playback advances time.
- Preset/domain changes produce coherent complete problems. Keep every shipped preset valid in all three domain choices. Invalid drafts remain editable while the last accepted plots stay visible.

## Mathematics and state

- Parse a whitelisted AST; never use `eval`, generated JavaScript, or `new Function`. Initial functions accept x, boundary data accepts t, and scalar fields accept constant expressions such as `pi/2` or `sqrt(2)`.
- Preserve arithmetic precedence, finite-value checks, valid piece coverage, zero extension on unbounded domains, and the limit of 16 pieces per initial function.
- Use characteristic propagation and exact Dirichlet/Neumann reflection relations with piece-aware, refinement-checked quadrature. Reject direct Dirichlet corner contradictions; distinguish compatibility warnings from invalid data so weak solutions remain explorable.
- Preserve true jump discontinuities in surfaces and slices. Adaptive sampling follows the accepted physical window, has bounded cost, and reports unresolved features rather than implying unsupported accuracy.
- One accepted problem/revision and one selected time drive all plots and controls. Never accept stale worker results. Keep valid draft state separate from accepted presentation and preserve focus/caret during editing.
- Characteristics follow dx/dt=±1, reflect at physical endpoints, terminate at t=0, and have bounded reflection work. Present their broken rays and event markers on the x–t floor.

## Design and accessibility

- Keep the visualization primary: a black stage, turquoise surface/snapshot, gold draggable time plane, compact controls, and readable mathematics. Use KaTeX for mathematical presentation and native text controls for editing.
- Keep spatial/time axes semantically consistent during camera movement and reset. Default views must contain their axis labels at desktop and compact sizes. Retain physical-boundary markers in both plots.
- Preserve the recognizable eta/red and xi/purple characteristic families with explicit labels; meaning must not depend only on color. Keep annotations concise.
- Layout, spacing, typography, camera fitting, and educational explanations may evolve when they improve clarity. Avoid hard-coded presentation constraints that prevent a better responsive design.
- Provide visible keyboard focus, named controls, useful validation messages, 44px primary touch targets, reduced-motion support, and a working SVG fallback when WebGL is unavailable. Avoid incidental native hover tooltips and horizontal overflow.

## Architecture and performance

- Keep orchestration in `src/app.ts`, draft/controllers in `src/ui/`, mathematics in `src/math/`, worker transport in `src/workers/`, rendering in `src/plot/`, and shared contracts in `src/types.ts`.
- Coalesce animation and interaction rendering through requestAnimationFrame. Reuse stable geometry and DOM, avoid duplicate solves, pause hidden-page work, and dispose listeners, workers, observers, and graphics resources.
- Prefer measured optimizations with numerical-equivalence checks. Keep software-renderer costs in mind before increasing geometry density, antialiasing, transparency passes, or device-pixel ratio.
- Benchmarks verify the renderer being measured, monitor browser errors, await fonts/stable layout, and use bounded page-owned completion signals. Report cold/warm starts and submission/presentation timing honestly.
- Reference targets: worker solve <600ms, initial surface <2.5s, frame callbacks p95 <16.7ms, no interaction Long Tasks ≥50ms. Shared CI timing is advisory; structural failures and browser errors remain blocking. Enforce timing only on calibrated hosts.

## Verification and delivery

- Use Node 24 and reproducible `npm ci`. Run unit tests and typecheck/build for implementation changes; run `npm run test:browser` and inspect a real browser for UI/rendering/lifecycle changes. Also run `npm run benchmark:browser` for numerical, sampling, or animation changes.
- Add meaningful regression tests for defects: analytic solutions and reflections, parser safety, stale revisions, discontinuities, invalid-draft retention, real keyboard/typing interactions, and compact layout. Update stable DOM/data automation hooks and browser checks together when changing their contract.
- Keep the single CI workflow testing the production artifact before deploying it from main. Do not weaken correctness checks to make a change pass.
- Keep README minimal. Do not commit dist, caches, browser diagnostics, or generated recordings; the existing showcase GIF is the intentional media exception.
- Keep this file short and durable. Record temporary experiments and detailed implementation history in documentation, not as new permanent constraints here.
