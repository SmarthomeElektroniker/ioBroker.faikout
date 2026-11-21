/*
 * Gemeinsame Zwischenablage der Einstellungsseite: Kennlinien, Temperaturstufen, Wochenplaene und die
 * Feuchte-Grenzen lassen sich von einem Geraet (oder der Vorlage) kopieren und an anderer Stelle
 * einfuegen. Gemerkt wird im sessionStorage des Browsers - die Kopie ueberlebt das Umschalten der
 * Reiter und das Neuladen der Seite, aber nicht das Schliessen des Fensters. Es gibt genau einen
 * Platz: eine neue Kopie ersetzt die alte, gleich welcher Art.
 *
 * Einfuegen darf eine Komponente nur, was zu ihr passt - deshalb gehoert zu jeder Kopie ihre Art.
 */
export type Art = 'kennlinieHeizen' | 'kennlinieKuehlen' | 'stufen' | 'wochenplan' | 'feuchte';

const SCHLUESSEL = 'faikout.zwischenablage';
const ARTEN: readonly string[] = ['kennlinieHeizen', 'kennlinieKuehlen', 'stufen', 'wochenplan', 'feuchte'];

interface Eintrag {
    art: Art;
    inhalt: unknown;
    quelle: string;
}

/** Ersatz, wenn der Browser keinen sessionStorage hergibt (gesperrt, privater Modus, Rendern auf dem Server). */
let imSpeicher: string | null = null;
const hoerer = new Set<() => void>();

function speicher(): Storage | null {
    try {
        return typeof window !== 'undefined' && window.sessionStorage ? window.sessionStorage : null;
    } catch {
        return null;
    }
}

function roh(): string | null {
    const s = speicher();
    if (s) {
        try {
            return s.getItem(SCHLUESSEL);
        } catch {
            // weiter mit dem Ersatz
        }
    }
    return imSpeicher;
}

function eintrag(): Eintrag | null {
    const text = roh();
    if (!text) {
        return null;
    }
    try {
        const e = JSON.parse(text) as Partial<Eintrag> | null;
        if (!e || typeof e.art !== 'string' || !ARTEN.includes(e.art) || e.inhalt === undefined) {
            return null;
        }
        return { art: e.art, inhalt: e.inhalt, quelle: typeof e.quelle === 'string' ? e.quelle : '' };
    } catch {
        return null;
    }
}

function melden(): void {
    for (const cb of [...hoerer]) {
        try {
            cb();
        } catch {
            // ein Hoerer mit Fehler darf die anderen nicht aufhalten
        }
    }
}

/** Merkt den Inhalt (als JSON) mit seiner Art und der Herkunft, z. B. dem Namen des Geraets. */
export function kopieren(art: Art, inhalt: unknown, quelle: string): void {
    const text = JSON.stringify({ art, inhalt, quelle: String(quelle ?? '') });
    imSpeicher = text;
    const s = speicher();
    if (s) {
        try {
            s.setItem(SCHLUESSEL, text);
        } catch {
            // voll oder gesperrt: die Kopie gilt dann nur bis zum Neuladen
        }
    }
    melden();
}

/** Der gemerkte Inhalt dieser Art - null, wenn nichts gemerkt ist oder etwas anderer Art. */
export function lesen(art: Art): { inhalt: unknown; quelle: string } | null {
    const e = eintrag();
    return e && e.art === art ? { inhalt: e.inhalt, quelle: e.quelle } : null;
}

/**
 * Meldet Aenderungen der Zwischenablage - aus dieser und aus anderen Komponenten, auch aus einem
 * eingebetteten Fenster derselben Seite (Wochenplan). Liefert die Funktion zum Abmelden.
 */
export function abonnieren(cb: () => void): () => void {
    hoerer.add(cb);
    const vonAussen = (e: StorageEvent): void => {
        if (e.key === null || e.key === SCHLUESSEL) {
            cb();
        }
    };
    const fenster = typeof window !== 'undefined' && typeof window.addEventListener === 'function' ? window : null;
    fenster?.addEventListener('storage', vonAussen);
    return () => {
        hoerer.delete(cb);
        fenster?.removeEventListener('storage', vonAussen);
    };
}

/**
 * Zusatz zur vereinbarten Schnittstelle (fuer den Hinweis am grauen Einfuegen-Knopf): Art und Herkunft
 * dessen, was gerade gemerkt ist - null bei leerer Zwischenablage.
 */
export function gemerkt(): { art: Art; quelle: string } | null {
    const e = eintrag();
    return e ? { art: e.art, quelle: e.quelle } : null;
}
