/*
 * Geschuetztes Leerzeichen (U+00A0) zwischen Zahl und Einheit - "21,5 °C", "60 %", "0,5 K" brechen nie
 * zwischen Zahl und Einheit um. Die Regel steht einmal in lib/kennlinienzug.js (wortgleich mit den
 * VIS-Bausteinen und dem Adapter); alle Textfunktionen der Komponenten (t, text, kt, wt) laufen hier durch.
 */
import zugLib from '../../lib/kennlinienzug.js';

const zug = zugLib as { einheitFest(text: unknown): string };

/** Text fuer die Anzeige: geschuetztes Leerzeichen zwischen Zahl und Einheit. */
export function fest(text: string): string {
    return zug.einheitFest(text);
}
