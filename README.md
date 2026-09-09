https://hodaka-kikuchi.github.io/TAS_QErange_Calc/

# TAS Q-E Range Simulator — JavaScript port

This is a browser-side JavaScript port of the supplied Python `app.py`,
`RL_calc.py`, and `UB_calc.py`.

## Files

- `index.html` — UI
- `styles.css` — layout
- `tas-core.js` — reciprocal-lattice / UB / vector math
- `app.js` — TAS accessible-range calculations and Plotly rendering

All numerical calculations run in the browser. There is no Streamlit or Python
server process.

## External data still required

The supplied `app.py` also loads JSON files from three directories that were
not included with the three Python files:

- `instruments/*.json`
- `sample/*.json`
- `sample_environments/*.json`

The JavaScript version therefore provides file pickers for these JSON files.
You can select multiple JSON files at once.

Expected schemas, inferred directly from `app.py`:

### Instrument

```json
{
  "name": "Instrument name",
  "energy_mode": "Ef fixed",
  "default_energy": 4.8,
  "S2_min": 8.0,
  "sense": "-+-",
  "configuration": [
    {"Ei": 3.0, "S2limit": 120.0},
    {"Ei": 10.0, "S2limit": 130.0}
  ]
}
```

`default_S2min` is also accepted because the powder branch of the Python file
uses that legacy key.

### Sample / holder

```json
{
  "name": "Material",
  "peaks": [
    {"h": 1, "k": 0, "l": 0, "d": 2.0, "intensity": 100.0}
  ]
}
```

### Sample environment

```json
{
  "name": "Environment",
  "dark_angle_reference": "Reference Q",
  "dark_angle_ranges": [
    {"from": -10, "to": 10, "offset": 0}
  ]
}
```

## Run

Because this project uses JavaScript modules, serve the directory over HTTP.
For example, from this folder:

```bash
python -m http.server 8000
```

and open `http://localhost:8000/`.

The only web dependency is Plotly.js, loaded from the Plotly CDN in
`index.html`.

## Important convention retained from the Python version

- The accessible Q region is independent of `+-+` / `-+-`.
- Instrument sense is applied only to the dark-angle mapping.
- The U/V plane basis uses the same canonical right-handed convention as the
  supplied Python code.
- `RL_calc` and `UB_calc` are translated directly rather than replaced by a
  different crystallographic convention.

## Validation still recommended

Before replacing the Python version, compare both implementations at several
known points, especially:

- non-cubic / non-orthogonal lattices
- U/V sign and order changes
- `+-+` and `-+-`
- dark-angle ranges
- λ/2 mode
- Ei-fixed and Ef-fixed
- powder mode


## Automatic JSON discovery

The app now discovers JSON configuration files automatically.

- Local development (`python -m http.server 8888`): the app reads the server's directory listing.
- GitHub Pages: the app reads the public GitHub Contents API for:
  - `instruments/`
  - `sample/`
  - `sample_environments/`
- `index.json` is still supported as an optional fallback, but it is no longer required for this repository.

Therefore, to add a new instrument, sample, or sample environment, add the corresponding `.json` file to the appropriate directory, commit, and push it to `main`.

The GitHub repository used by the automatic loader is configured near the top of `app.js`:

```javascript
const GITHUB_REPO_OWNER = "Hodaka-Kikuchi";
const GITHUB_REPO_NAME = "TAS_QErange_Calc";
const GITHUB_REPO_BRANCH = "main";
```
