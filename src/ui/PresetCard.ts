/**
 * @fileoverview PresetCard — a card component for a single life preset.
 *
 * Renders an article element containing:
 *   - An archetype colour-coded badge (Primitive / Aggressive / etc.)
 *   - Difficulty rating (1–5 filled/empty stars)
 *   - Preset name
 *   - One-line description
 *   - An [Apply] button that calls the supplied callback
 *
 * Usage:
 * ```ts
 * const card = buildPresetCard(preset, () => {
 *   appState.config = { ...preset.config };
 *   syncSliders();
 * });
 * listEl.append(card);
 * ```
 */

import { type LifePreset } from '../simulation/config/SimulationConfig.js';

// ---------------------------------------------------------------------------
// Archetype display metadata
// ---------------------------------------------------------------------------

/** Human-readable label for each archetype value. */
const ARCHETYPE_LABELS: Record<string, string> = {
  primitive:   'Primitive',
  aggressive:  'Aggressive',
  cooperative: 'Cooperative',
  resilient:   'Resilient',
  chaotic:     'Chaotic',
};

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Builds a card DOM element for a single life preset.
 *
 * @param preset  - The life preset to display.
 * @param onApply - Called when the user clicks [Apply].
 * @returns       The constructed card element.
 */
export function buildPresetCard(
  preset: LifePreset,
  onApply: () => void,
): HTMLElement {
  // Root article element — carries the archetype as a data attribute and CSS
  // class so styles can key off it via [data-archetype].
  const article = document.createElement('article');
  article.className   = 'preset-card';
  article.dataset['archetype'] = preset.meta.archetype;

  // ----- Header row: badge (left) + difficulty stars (right) ---------------
  const header = document.createElement('div');
  header.className = 'preset-card-header';

  const badge = document.createElement('span');
  badge.className   = `preset-card-badge preset-archetype-${preset.meta.archetype}`;
  badge.textContent = ARCHETYPE_LABELS[preset.meta.archetype] ?? preset.meta.archetype;

  const diff = document.createElement('span');
  diff.className = 'preset-card-difficulty';
  // Unicode filled/empty stars provide a compact, visually clear difficulty rating.
  diff.textContent  = '★'.repeat(preset.meta.difficulty) + '☆'.repeat(5 - preset.meta.difficulty);
  diff.setAttribute('aria-label', `Difficulty ${preset.meta.difficulty} of 5`);
  diff.title        = `Difficulty: ${preset.meta.difficulty} / 5`;

  header.append(badge, diff);

  // ----- Preset name -------------------------------------------------------
  const name = document.createElement('h3');
  name.className   = 'preset-card-name';
  name.textContent = preset.meta.name;

  // ----- Description -------------------------------------------------------
  const desc = document.createElement('p');
  desc.className   = 'preset-card-desc';
  desc.textContent = preset.meta.description;

  // ----- Apply button -------------------------------------------------------
  const applyBtn = document.createElement('button');
  applyBtn.type      = 'button';
  applyBtn.className = 'preset-card-apply';
  applyBtn.textContent = 'Apply';
  applyBtn.setAttribute('aria-label', `Apply ${preset.meta.name} life preset`);
  applyBtn.addEventListener('click', () => onApply());

  article.append(header, name, desc, applyBtn);
  return article;
}
