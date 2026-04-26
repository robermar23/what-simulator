/**
 * @fileoverview EnvironmentCard — a card component for a single environment preset.
 *
 * Renders an article element containing:
 *   - Category badge (colour-coded) + background type pill + difficulty stars
 *   - Environment name
 *   - Two-line description
 *   - Suggested life preset pairing (clickable — applies the life preset)
 *   - An [Apply Environment] button that emits `applyEnvironment` on the bus
 *
 * Usage:
 * ```ts
 * const card = buildEnvironmentCard(envPreset, (lifeKey) => {
 *   applyLifePreset(lifeKey);   // supplied by PresetPanel
 * });
 * listEl.append(card);
 * ```
 */

import { bus }                              from '../state/EventBus.js';
import { LIFE_PRESETS }                     from '../simulation/config/SimulationConfig.js';
import { type EnvironmentPreset }           from '../simulation/config/EnvironmentPresets.js';

// ---------------------------------------------------------------------------
// Category display metadata
// ---------------------------------------------------------------------------

/** Human-readable label for each environment category. */
const CATEGORY_LABELS: Record<string, string> = {
  biological: 'Biological',
  geological: 'Geological',
  chemical:   'Chemical',
  physical:   'Physical',
  abstract:   'Abstract',
};

/** Human-readable label for each background type. */
const BG_LABELS: Record<string, string> = {
  petri:   'Petri',
  water:   'Water',
  leaf:    'Leaf',
  soil:    'Soil',
  space:   'Space',
  deepSea: 'Deep Sea',
};

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Builds a card DOM element for a single environment preset.
 *
 * @param preset          - The environment preset to display.
 * @param onApplyLife     - Called with a life-preset key when the user clicks
 *                          the suggested pairing pill.  PresetPanel handles
 *                          the actual config update and slider sync.
 * @returns               The constructed card element.
 */
export function buildEnvironmentCard(
  preset: EnvironmentPreset,
  onApplyLife: (lifeKey: string) => void,
): HTMLElement {
  const article = document.createElement('article');
  article.className          = 'env-card';
  article.dataset['category'] = preset.category;

  // ----- Header row: category badge | bg pill | difficulty stars -----------
  const header = document.createElement('div');
  header.className = 'env-card-header';

  const catBadge = document.createElement('span');
  catBadge.className   = `env-card-badge env-category-${preset.category}`;
  catBadge.textContent = CATEGORY_LABELS[preset.category] ?? preset.category;

  const bgPill = document.createElement('span');
  bgPill.className   = 'env-card-bg-pill';
  bgPill.textContent = BG_LABELS[preset.backgroundType] ?? preset.backgroundType;
  bgPill.title       = `Background: ${preset.backgroundType}`;

  const diff = document.createElement('span');
  diff.className   = 'preset-card-difficulty'; // reuse life-preset difficulty style
  diff.textContent = '★'.repeat(preset.difficulty) + '☆'.repeat(5 - preset.difficulty);
  diff.setAttribute('aria-label', `Difficulty ${preset.difficulty} of 5`);
  diff.title       = `Difficulty: ${preset.difficulty} / 5`;

  header.append(catBadge, bgPill, diff);

  // ----- Environment name --------------------------------------------------
  const name = document.createElement('h3');
  name.className   = 'preset-card-name env-card-name';
  name.textContent = preset.name;

  // ----- Description -------------------------------------------------------
  const desc = document.createElement('p');
  desc.className   = 'preset-card-desc';
  desc.textContent = preset.description;

  // ----- Suggested life preset pairing ------------------------------------
  // Shows the display name of the recommended life preset and lets the user
  // apply it with a single click — convenient when exploring combinations.
  const pairingLine = _buildPairingLine(preset.recommendedLifePreset, onApplyLife);
  if (pairingLine) article.append(header, name, desc, pairingLine);
  else             article.append(header, name, desc);

  // ----- Apply Environment button -----------------------------------------
  const applyBtn = document.createElement('button');
  applyBtn.type        = 'button';
  applyBtn.className   = 'preset-card-apply env-card-apply';
  applyBtn.textContent = 'Apply Environment';
  applyBtn.setAttribute('aria-label', `Apply ${preset.name} environment`);

  applyBtn.addEventListener('click', () => {
    bus.emit('applyEnvironment', {
      key:                 preset.key,
      backgroundType:      preset.backgroundType,
      spec:                preset.obstacleSpec,
      seedDensityOverride: preset.seedDensityOverride,
    });
  });

  article.append(applyBtn);
  return article;
}

// ---------------------------------------------------------------------------
// Private helpers
// ---------------------------------------------------------------------------

/**
 * Builds the "Suggested life: …" pairing line, or returns null if the
 * recommended key doesn't match any known preset.
 *
 * @param recommendedKey - Life preset key from the environment preset.
 * @param onApply        - Callback to invoke when the pairing button is clicked.
 * @returns              Pairing line element, or null if key not found.
 */
function _buildPairingLine(
  recommendedKey: string,
  onApply: (key: string) => void,
): HTMLElement | null {
  const lifePreset = LIFE_PRESETS.find(p => p.key === recommendedKey);
  if (!lifePreset) return null;

  const line = document.createElement('p');
  line.className = 'env-card-pairing';

  const label = document.createElement('span');
  label.className   = 'env-card-pairing-label';
  label.textContent = 'Suggested life: ';

  const btn = document.createElement('button');
  btn.type      = 'button';
  btn.className = 'env-card-pair-btn';
  btn.textContent = lifePreset.meta.name;
  btn.title       = `Apply "${lifePreset.meta.name}" life preset`;
  btn.addEventListener('click', (e) => {
    // Stop propagation so clicking the pairing pill doesn't also trigger
    // the card's own apply button if they're ever stacked.
    e.stopPropagation();
    onApply(lifePreset.key);
  });

  line.append(label, btn);
  return line;
}
