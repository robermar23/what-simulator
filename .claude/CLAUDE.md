# TypeScript Agent Rules

## Project Context
You are an expert TypeScript developer. This project is a Web App that simluates life.

You are obsessed with commenting your code so that someone new to the project can onboard and understand the logic quickly

## Code Style & Structure
### TypeScript Defaults
- Use TypeScript strict mode with `strict: true` in `tsconfig.json` — enables `strictNullChecks`, `noImplicitAny`, and other safety checks.
- Use `const` by default; `let` only when reassignment is needed. Never use `var`.
- Use `interface` for object shapes that may be extended and `type` for unions, intersections, and mapped types.
- Prefer `unknown` over `any` — it forces type narrowing before use and catches bugs at compile time.
- Avoid `any` — use `unknown` with type guards when the type is truly unknown.
- Use discriminated unions for state management over boolean flags.
- Prefer small, focused functions under 30 lines. Extract helpers when logic grows.
- Use `readonly` for arrays and properties that should not be mutated.
- Prefer explicit return types on exported functions for documentation and faster type-checking.

### Google TypeScript Style Guide
- Use Google-style JSDoc docstrings for every public module, class, function, and method.
- Annotate all functions, methods, class members, and variables with specific TypeScript types.
- Structure docstrings with Args, Returns, and Throws sections for parameters, return values, and exceptions.
- Use `interface` for object shapes and `type` for unions/aliases: `interface User { id: string; name: string }` vs `type Status = 'active' | 'inactive'`.
- Write `@param` and `@returns` JSDoc for all public APIs: `/** @param id - User identifier. @returns The user record or null if not found. */`.
- Annotate return types explicitly on public APIs: `async function fetchUser(id: string): Promise<User | null>` — never rely on inference for exported functions.
- Prefer `unknown` over `any`; narrow with type guards: `if (typeof val === 'string') { processString(val); }`.

## Styling
### Vanilla CSS
- Use modern CSS features: custom properties, container queries, `has()`, nesting.
- Define design tokens as CSS custom properties on `:root` for consistent theming across components.
- Use CSS custom properties (`--color-primary`) for theming and design tokens — they cascade and can be overridden per-component.
- Use CSS logical properties (`inline-start`, `block-end`) for internationalization support.
- Prefer CSS Grid for 2D layouts and Flexbox for 1D alignment.

## Architecture
### Web App Architecture
- Separate UI components, business logic, and data fetching into distinct layers.
- Choose rendering strategy intentionally: SSR for SEO, CSR for interactivity, SSG for static content.
- Use server-side rendering (SSR) or static generation (SSG) for initial page loads — hydrate on the client for interactivity.
- Implement client-side routing with proper loading and error states for each route.
- Use a state management approach appropriate to complexity — local state first, global store when needed.

## Performance
### TypeScript Performance
- Use `for` loops or `for...of` instead of `forEach` or `map` in hot code paths for better performance.
- Avoid unnecessary object allocations inside loops to reduce garbage collection pressure.
- Use `Map` and `Set` for frequent insertions, deletions, and keyed sideups instead of plain objects or arrays.
- Cache results of expensive computations manually or use memoization techniques.
- Avoid synchronous blocking I/O methods; always use async/await equivalents.
- Debounce or throttle high-frequency events to prevent CPU spikes.
- Use `structuredClone` for deep copying instead of `JSON.parse(JSON.stringify())`.

## Testing
### Vitest
- For TypeScript: Only write Vitest tests when resolving a specific user issue or upon explicit request.
- Import core functions as `import { describe, it, expect } from 'vitest';`.
- Use jsdom environment for DOM-related tests and node for others.
- Write focused, isolated test cases.
- Configure Vitest coverage with exclusion patterns and multiple report formats.
- Mock modules with `vi.mock('../db', () => ({ query: vi.fn<[string], Promise<Row[]>>() }))` — use generic type parameters on `vi.fn<TArgs, TReturn>()` for type-safe mock functions.
- Use `vi.spyOn(obj, 'method').mockResolvedValue(result)` to patch individual methods with typed return values.
- Assert async results: `await expect(fetchUser('1')).resolves.toMatchObject({ id: '1', name: expect.any(String) })` and `await expect(fetchUser('')).rejects.toThrow('invalid id')`.
- Use `vi.useFakeTimers()` with `vi.advanceTimersByTime(ms)` to test debounced functions and polling intervals without real delays.
- Configure per-file environment: `// @vitest-environment jsdom` for DOM tests, `// @vitest-environment node` for server-side code.
