/**
 * @fileoverview PresetPanel — tabbed panel for Life Presets and Environments.
 *
 * Provides two tabs:
 *   [Life Presets]  — scrollable grid of life preset cards, filterable by
 *                     archetype chip (All / Primitive / Aggressive / …).
 *   [Environments]  — scrollable grid of environment preset cards, filterable
 *                     by category chip; includes Randomize and Clear buttons.
 *
 * The panel knows about `appState` and the EventBus so it can apply presets
 * directly without any ControlPanel coupling, except for the `syncSliders`
 * callback which the ControlPanel provides so its slider readouts stay in sync
 * when a preset is loaded.
 *
 * Usage (from ControlPanel):
 * ```ts
 * const panel = new PresetPanel(() => this._syncSliders());
 * section.append(panel.build());
 * ```
 */

import { appState }                         from '../state/AppState.js';
import { bus }                              from '../state/EventBus.js';
import { LIFE_PRESETS }                     from '../simulation/config/SimulationConfig.js';
import { ENVIRONMENT_PRESETS }              from '../simulation/config/EnvironmentPresets.js';
import { buildPresetCard }                  from './PresetCard.js';
import { buildEnvironmentCard }             from './EnvironmentCard.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Valid archetype filter values. */
type ArchetypeFilter = 'all' | 'primitive' | 'aggressive' | 'cooperative' | 'resilient' | 'chaotic';

/** Valid category filter values. */
type CategoryFilter = 'all' | 'biological' | 'geological' | 'chemical' | 'physical' | 'abstract';

// ---------------------------------------------------------------------------
// Filter chip definitions
// ---------------------------------------------------------------------------

/** Life preset archetype filter chips (left-to-right display order). */
const ARCHETYPE_CHIPS: Array<{ value: ArchetypeFilter; label: string }> = [
  { value: 'all',         label: 'All'         },
  { value: 'primitive',   label: 'Primitive'   },
  { value: 'aggressive',  label: 'Aggressive'  },
  { value: 'cooperative', label: 'Cooperative' },
  { value: 'resilient',   label: 'Resilient'   },
  { value: 'chaotic',     label: 'Chaotic'     },
];

/** Environment category filter chips. */
const CATEGORY_CHIPS: Array<{ value: CategoryFilter; label: string }> = [
  { value: 'all',        label: 'All'        },
  { value: 'biological', label: 'Bio'        },
  { value: 'geological', label: 'Geo'        },
  { value: 'chemical',   label: 'Chem'       },
  { value: 'physical',   label: 'Physical'   },
  { value: 'abstract',   label: 'Abstract'   },
];

// ---------------------------------------------------------------------------
// PresetPanel class
// ---------------------------------------------------------------------------

/**
 * Tabbed preset selection panel.
 *
 * Instantiate once, call `build()` to get the DOM element to insert into the
 * control panel sidebar.
 */
export class PresetPanel {
  /**
   * Callback supplied by ControlPanel.  Invoked after a life preset config is
   * applied to `appState.config` so the slider readouts stay in sync.
   */
  private readonly _syncSliders: () => void;

  /**
   * Key of the most recently applied environment preset.
   * Used by the Randomize Obstacles button to re-generate a new random layout
   * for the same environment without the user needing to re-select it.
   */
  private _lastEnvKey: string | null = null;

  /**
   * @param syncSliders - ControlPanel callback to sync all slider readouts
   *                      after a preset config has been loaded into appState.
   */
  constructor(syncSliders: () => void) {
    this._syncSliders = syncSliders;
  }

  // ---------------------------------------------------------------------------
  // Public API
  // ---------------------------------------------------------------------------

  /**
   * Builds the complete preset panel DOM and returns the root element.
   *
   * @returns The preset panel root element ready to be inserted into the DOM.
   */
  build(): HTMLElement {
    const root = document.createElement('div');
    root.className = 'preset-panel';

    // Tab bar — two buttons that toggle which content pane is visible.
    const tabBar = this._buildTabBar();
    root.append(tabBar);

    // Life presets content pane.
    const lifePane = this._buildLifePane();
    lifePane.dataset['tab'] = 'life';
    lifePane.classList.add('preset-tab-content');

    // Environment presets content pane.
    const envPane = this._buildEnvPane();
    envPane.dataset['tab'] = 'env';
    envPane.classList.add('preset-tab-content', 'preset-tab-content--hidden');

    root.append(lifePane, envPane);

    // Wire tab switching.
    this._wireTabBar(tabBar, lifePane, envPane);

    return root;
  }

  // ---------------------------------------------------------------------------
  // Private — tab bar
  // ---------------------------------------------------------------------------

  /**
   * Builds the two-button tab bar.
   *
   * @returns Tab bar `<div>` element.
   */
  private _buildTabBar(): HTMLElement {
    const bar = document.createElement('div');
    bar.className   = 'preset-panel-tabs';
    bar.setAttribute('role', 'tablist');

    const lifeTab = document.createElement('button');
    lifeTab.type        = 'button';
    lifeTab.className   = 'preset-tab preset-tab--active';
    lifeTab.textContent = 'Life';
    lifeTab.setAttribute('role', 'tab');
    lifeTab.setAttribute('aria-selected', 'true');
    lifeTab.dataset['target'] = 'life';

    const envTab = document.createElement('button');
    envTab.type        = 'button';
    envTab.className   = 'preset-tab';
    envTab.textContent = 'Environments';
    envTab.setAttribute('role', 'tab');
    envTab.setAttribute('aria-selected', 'false');
    envTab.dataset['target'] = 'env';

    bar.append(lifeTab, envTab);
    return bar;
  }

  /**
   * Wires tab click events so switching tabs shows/hides the right pane and
   * updates ARIA attributes.
   *
   * @param bar      - The tab bar element.
   * @param lifePane - The life presets content pane.
   * @param envPane  - The environment presets content pane.
   */
  private _wireTabBar(
    bar:      HTMLElement,
    lifePane: HTMLElement,
    envPane:  HTMLElement,
  ): void {
    const tabs  = Array.from(bar.querySelectorAll<HTMLButtonElement>('.preset-tab'));
    const panes = [lifePane, envPane];

    for (const tab of tabs) {
      tab.addEventListener('click', () => {
        const target = tab.dataset['target'];

        // Update tab active states.
        for (const t of tabs) {
          const isActive = t === tab;
          t.classList.toggle('preset-tab--active', isActive);
          t.setAttribute('aria-selected', String(isActive));
        }

        // Show only the matching pane.
        for (const pane of panes) {
          const isVisible = pane.dataset['tab'] === target;
          pane.classList.toggle('preset-tab-content--hidden', !isVisible);
        }
      });
    }
  }

  // ---------------------------------------------------------------------------
  // Private — Life pane
  // ---------------------------------------------------------------------------

  /**
   * Builds the Life Presets tab content pane.
   *
   * Contains archetype filter chips and a scrollable list of preset cards.
   *
   * @returns Life pane element.
   */
  private _buildLifePane(): HTMLElement {
    const pane = document.createElement('div');

    // Filter chip row.
    let activeFilter: ArchetypeFilter = 'all';
    const chips = this._buildFilterChips(
      ARCHETYPE_CHIPS,
      'all',
      (value) => {
        activeFilter = value as ArchetypeFilter;
        _filterCards(list, 'archetype', value);
      },
    );
    pane.append(chips);

    // Scrollable card list.
    const list = document.createElement('div');
    list.className = 'preset-card-list';

    for (const preset of LIFE_PRESETS) {
      const card = buildPresetCard(preset, () => this._applyLifePreset(preset.key));
      card.dataset['archetype'] = preset.meta.archetype;
      list.append(card);
    }

    // Suppress unused-variable warning on activeFilter while keeping it for
    // potential future "show active" tracking.
    void activeFilter;

    pane.append(list);
    return pane;
  }

  // ---------------------------------------------------------------------------
  // Private — Environment pane
  // ---------------------------------------------------------------------------

  /**
   * Builds the Environments tab content pane.
   *
   * Contains category filter chips, a scrollable list of environment cards,
   * and Randomize Obstacles / Clear Environment action buttons.
   *
   * @returns Environment pane element.
   */
  private _buildEnvPane(): HTMLElement {
    const pane = document.createElement('div');

    // Filter chip row.
    const chips = this._buildFilterChips(
      CATEGORY_CHIPS,
      'all',
      (value) => _filterCards(list, 'category', value),
    );
    pane.append(chips);

    // Scrollable card list.
    const list = document.createElement('div');
    list.className = 'preset-card-list';

    for (const env of ENVIRONMENT_PRESETS) {
      const card = buildEnvironmentCard(env, (lifeKey) => this._applyLifePreset(lifeKey));

      // Track last applied environment for Randomize button.
      // Wire up the Apply Environment button's side-effect of updating _lastEnvKey.
      const applyBtn = card.querySelector<HTMLButtonElement>('.env-card-apply');
      if (applyBtn) {
        applyBtn.addEventListener('click', () => {
          this._lastEnvKey = env.key;
        });
      }

      card.dataset['category'] = env.category;
      list.append(card);
    }

    pane.append(list);

    // Action buttons row.
    pane.append(this._buildEnvActions());

    return pane;
  }

  /**
   * Builds the Randomize Obstacles + Clear Environment action buttons row.
   *
   * @returns Actions `<div>` element.
   */
  private _buildEnvActions(): HTMLElement {
    const row = document.createElement('div');
    row.className = 'preset-env-actions';

    // Randomize Obstacles — re-generates the last applied environment with a
    // fresh non-deterministic random seed, producing a different layout.
    const randomizeBtn = document.createElement('button');
    randomizeBtn.type        = 'button';
    randomizeBtn.className   = 'preset-btn';
    randomizeBtn.textContent = 'Randomize Obstacles';
    randomizeBtn.title       = 'Re-generate current environment\'s obstacles with a new random layout';
    randomizeBtn.addEventListener('click', () => {
      const key = this._lastEnvKey;
      if (!key) return;
      const env = ENVIRONMENT_PRESETS.find(e => e.key === key);
      if (!env) return;
      // Force non-deterministic generation by clearing the deterministic flag.
      bus.emit('applyEnvironment', {
        key:                 env.key,
        backgroundType:      env.backgroundType,
        spec:                { ...env.obstacleSpec, deterministic: false },
        seedDensityOverride: env.seedDensityOverride,
      });
    });

    // Clear Environment — applies "The Void" (empty obstacle spec) to remove
    // all non-life obstacle cells from the grid.
    const clearBtn = document.createElement('button');
    clearBtn.type        = 'button';
    clearBtn.className   = 'preset-btn';
    clearBtn.textContent = 'Clear Environment';
    clearBtn.title       = 'Remove all obstacle cells, leaving only empty space';
    clearBtn.addEventListener('click', () => {
      const voidPreset = ENVIRONMENT_PRESETS.find(e => e.key === 'theVoid');
      if (!voidPreset) return;
      bus.emit('applyEnvironment', {
        key:                 voidPreset.key,
        backgroundType:      voidPreset.backgroundType,
        spec:                voidPreset.obstacleSpec,
        seedDensityOverride: voidPreset.seedDensityOverride,
      });
    });

    row.append(randomizeBtn, clearBtn);
    return row;
  }

  // ---------------------------------------------------------------------------
  // Private — filter chips
  // ---------------------------------------------------------------------------

  /**
   * Builds a row of filter chips.
   *
   * Only one chip is active at a time.  Clicking a chip calls `onChange` with
   * the chip's value, which the caller uses to filter the card list.
   *
   * @param chips        - Chip definitions (value + display label).
   * @param defaultValue - Initially active chip value.
   * @param onChange     - Called with the new filter value when a chip is clicked.
   * @returns            The chip row element.
   */
  private _buildFilterChips<T extends string>(
    chips: Array<{ value: T; label: string }>,
    defaultValue: T,
    onChange: (value: T) => void,
  ): HTMLElement {
    const row = document.createElement('div');
    row.className = 'preset-filter-chips';
    row.setAttribute('role', 'group');
    row.setAttribute('aria-label', 'Filter presets');

    const btns: HTMLButtonElement[] = [];

    for (const chip of chips) {
      const btn = document.createElement('button');
      btn.type        = 'button';
      btn.className   = 'filter-chip';
      btn.textContent = chip.label;
      btn.dataset['value'] = chip.value;
      if (chip.value === defaultValue) btn.classList.add('filter-chip--active');

      btn.addEventListener('click', () => {
        for (const b of btns) {
          b.classList.toggle('filter-chip--active', b === btn);
        }
        onChange(chip.value);
      });

      btns.push(btn);
      row.append(btn);
    }

    return row;
  }

  // ---------------------------------------------------------------------------
  // Private — life preset application
  // ---------------------------------------------------------------------------

  /**
   * Applies a life preset by key: writes the config into `appState` and
   * invokes the slider sync callback so the panel readouts update.
   *
   * @param key - The life preset key to apply.
   */
  private _applyLifePreset(key: string): void {
    const preset = LIFE_PRESETS.find(p => p.key === key);
    if (!preset) return;

    // Spread to create a mutable copy — appState.config is mutated by sliders,
    // so we must not share the readonly preset config object directly.
    appState.config = { ...preset.config };
    this._syncSliders();
  }
}

// ---------------------------------------------------------------------------
// Module-level helpers
// ---------------------------------------------------------------------------

/**
 * Filters the card list to show only cards matching the given value.
 * When value is `'all'`, all cards are shown.
 *
 * @param list     - The card list container element.
 * @param dataKey  - The `dataset` key to filter on ('archetype' or 'category').
 * @param value    - The value to match, or 'all' to show everything.
 */
function _filterCards(list: HTMLElement, dataKey: string, value: string): void {
  for (const child of list.children) {
    const el = child as HTMLElement;
    const matches = value === 'all' || el.dataset[dataKey] === value;
    el.classList.toggle('preset-card--hidden', !matches);
  }
}
