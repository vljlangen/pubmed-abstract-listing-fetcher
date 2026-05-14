# PubMed Abstract Listing Fetcher

Build a **single continuous HTML page** of PubMed abstracts from a plain-text reference list (one non-empty line per reference). Optional **desktop app** (Windows / macOS) packages the same engine with a simple UI and a ZIP export (HTML, PDF, TXT).

**Latest downloads (GitHub Releases):**  
[https://github.com/vljlangen/pubmed-abstract-listing-fetcher/releases/latest](https://github.com/vljlangen/pubmed-abstract-listing-fetcher/releases/latest)

## Reference list format (`references.txt`)

Use **one reference per line**; empty lines are skipped. Optional leading list numbers (for example `1. `) are fine and are removed before search.

References should look **Vancouver-like** (typical numbered biomedical lists): **authors** first (often with `et al.`), then the **article title** and journal/year/DOI details. The fetcher needs a clear boundary **between the author block and the start of the title**: use either a **full stop (period)** or a **colon** there—for example `…Lastname AB, Other CD. Title starts here…` or `…Lastname AB, et al: Title starts here…`. (Other colons in the line, such as in volume/issue `14(1):179` or in `doi:…`, are ignored when picking that split.)

See the sample [`references.txt`](references.txt) in this repository for real lines.

**Example output:** a successful run on that file is saved as [`pubmed_abstracts_example.html`](pubmed_abstracts_example.html)—open it in a browser to see the layout and abstracts. The name ends in **`_example`** on purpose: the script’s default output is **`pubmed_abstracts.html`**, which is listed in `.gitignore` so local runs do not create noisy diffs; the example stays in git as a stable preview without embedding the whole HTML in this README.

---

## 1) Windows (PC)

1. Open **[Releases → Latest](https://github.com/vljlangen/pubmed-abstract-listing-fetcher/releases/latest)**.
2. Under **Assets**, download the **portable `.exe`** (x64).
3. Run the `.exe`. Paste references or choose a `.txt` file, then use **Get abstracts & save ZIP** when prompted to save the bundle.

If Windows SmartScreen warns about an unknown publisher, you may need **More info → Run anyway**.

---

## 2) macOS

1. Open **[Releases → Latest](https://github.com/vljlangen/pubmed-abstract-listing-fetcher/releases/latest)**.
2. Under **Assets**, download the **`.dmg` for your Mac**:
   - **Apple Silicon (M1 / M2 / M3 / …):** choose the DMG whose name includes **`arm64`** (if both are offered).
   - **Intel Macs:** choose the **x64 / Intel** DMG (often the one **without** `arm64` in the name).
3. Open the DMG, drag the app to **Applications**, launch it from there the first time. If Gatekeeper blocks it, use **Right-click → Open** once.

---

## 3) Linux (and anyone who prefers the command line)

**Install Node.js** (JavaScript runtime) **20 or newer** on your machine first—Linux does not include it by default. Use your distribution’s packages, [NodeSource](https://github.com/nodesource/distributions), or the official installer from [nodejs.org](https://nodejs.org/).

Then use the script in this repository (no Electron app is involved for this path):

1. Clone or copy the repo and `cd` into it.
2. Put your references in a file named **`references.txt`** in **the same directory** (or pass explicit paths—see below).
3. Run:

```bash
node pubmed_abstracts.js
```

Defaults:

- Input: **`references.txt`**
- Output: **`pubmed_abstracts.html`** (written in the **current working directory**)

Custom paths:

```bash
node pubmed_abstracts.js path/to/references.txt path/to/output.html
```

Optional: set **`NCBI_API_KEY`** (and **`NCBI_CONTACT_EMAIL`**) in the environment for higher NCBI rate limits and polite identification.

---

## License

See [`LICENSE`](LICENSE) (MIT).

---

## Building or customizing the desktop app from source

**Most Windows and macOS users** should use the **ready-made app** from **[Releases → Latest](https://github.com/vljlangen/pubmed-abstract-listing-fetcher/releases/latest)**—under **Assets**, pick the **`.exe`** or **`.dmg`** that matches your computer.

If you want to **change the program** or **build your own installers** from this repository, continue below.

### What you are installing

- **`npm install`** reads **`package.json`** and installs **all** declared dependencies: **`electron`** (devDependency; used to run and package the **desktop UI**) and **`archiver`** (dependency; used by the Electron main process when creating the ZIP). Nested libraries those tools need are pulled in automatically. This is **not** a separate “JavaScript install” besides Node—**Node.js** runs the scripts, and **npm** fetches the listed packages.
- The **graphical app** is an **Electron** application: the windows, buttons, and progress view live under `electron/`, and Electron provides the Chromium-based shell that also generates the PDF.

The command-line script **`pubmed_abstracts.js`** can still be run with **`node pubmed_abstracts.js`** after a clone **without** `npm install` if you only need the listing engine and already have Node 20+—but to work on or build the **Electron UI**, run **`npm install`** once from the repo root.

From the repo root (**Node.js 20+** and **npm** required). On **Linux**, install Node the same way as in **section 3** if it is not already on your `PATH`.

```bash
npm install
npm run dist          # on a Linux machine: default Linux targets for this CPU (see terminal output; often AppImage / deb under dist-electron/)
npm run dist:mac      # Apple Silicon DMG + ZIP (on Apple Silicon Mac)
npm run dist:mac-x64  # Intel Mac DMG + ZIP
npm run dist:win      # Windows x64 portable .exe
```

Linux packaging sometimes needs extra distro packages (for example tooling used to assemble `.deb` files). If the build errors, see the [electron-builder Linux](https://www.electron.build/linux.html) notes for dependencies.

Artifacts appear under `dist-electron/` (ignored by git).
