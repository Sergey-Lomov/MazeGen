/** License of a bundled font; keys the full text served from `public/licenses/`. */
export type FontLicense = "apache-2.0" | "ofl-1.1";

/** Where the full text of each license is served from (a static asset, fetched when the dialog opens). */
export const LICENSE_TEXT_URLS: Record<FontLicense, string> = {
  "apache-2.0": "/licenses/Apache-2.0.txt",
  "ofl-1.1": "/licenses/OFL-1.1.txt",
};

export interface FontNotice {
  /** Id of the catalog entry in `MSDF_FONTS` (`msdf:<id>`, or the default font for Roboto). */
  id: string;
  name: string;
  /** Copyright line exactly as the font's own license file gives it. */
  copyright: string;
  license: FontLicense;
  source: string;
}

/** Copyright notices of the baked MSDF fonts (GitHub issue #982). A baked atlas is a modified version
 *  of the font, so each font's copyright line and license ship with the app. Add an entry here, and the
 *  license file next to the font sources in `tools/msdf/`, together with every new baked font. */
export const FONT_NOTICES: FontNotice[] = [
  {
    id: "roboto",
    name: "Roboto",
    copyright: "Copyright 2015 Google Inc. All Rights Reserved.",
    license: "apache-2.0",
    source: "https://github.com/googlefonts/roboto",
  },
  {
    id: "noto-sans",
    name: "Noto Sans",
    copyright: "Copyright 2022 The Noto Project Authors (https://github.com/notofonts/latin-greek-cyrillic)",
    license: "ofl-1.1",
    source: "https://github.com/notofonts/latin-greek-cyrillic",
  },
  {
    id: "noto-sans-condensed",
    name: "Noto Sans Condensed",
    copyright: "Copyright 2022 The Noto Project Authors (https://github.com/notofonts/latin-greek-cyrillic)",
    license: "ofl-1.1",
    source: "https://github.com/notofonts/latin-greek-cyrillic",
  },
  {
    id: "noto-serif",
    name: "Noto Serif",
    copyright: "Copyright 2022 The Noto Project Authors (https://github.com/notofonts/latin-greek-cyrillic)",
    license: "ofl-1.1",
    source: "https://github.com/notofonts/latin-greek-cyrillic",
  },
  {
    id: "fira-sans",
    name: "Fira Sans",
    copyright: "Copyright (c) 2012-2015, The Mozilla Foundation and Telefonica S.A.",
    license: "ofl-1.1",
    source: "https://github.com/mozilla/Fira",
  },
  {
    id: "fira-mono",
    name: "Fira Mono",
    copyright: "Copyright (c) 2012-2013, The Mozilla Corporation and Telefonica S.A.",
    license: "ofl-1.1",
    source: "https://github.com/mozilla/Fira",
  },
  {
    id: "arimo",
    name: "Arimo",
    copyright: "Copyright 2026 The Arimo Project Authors (https://github.com/googlefonts/Arimo)",
    license: "ofl-1.1",
    source: "https://github.com/googlefonts/arimo",
  },
  {
    id: "tinos",
    name: "Tinos",
    copyright: "Copyright 2026 The Tinos Project Authors (https://github.com/googlefonts/tinos)",
    license: "ofl-1.1",
    source: "https://github.com/googlefonts/tinos",
  },
  {
    id: "cousine",
    name: "Cousine",
    copyright: "Copyright 2026 The Cousine Project Authors (https://github.com/googlefonts/cousine)",
    license: "ofl-1.1",
    source: "https://github.com/googlefonts/cousine",
  },
  {
    id: "open-sans",
    name: "Open Sans",
    copyright: "Copyright 2020 The Open Sans Project Authors (https://github.com/googlefonts/opensans)",
    license: "ofl-1.1",
    source: "https://github.com/googlefonts/opensans",
  },
];
