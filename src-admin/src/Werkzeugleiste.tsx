/*
 * Gemeinsame Knopfleiste der Regelungs-Komponenten: Kopieren, Einfuegen, Zuruecksetzen - und nach dem
 * Einfuegen oder Zuruecksetzen eine kurze Bestaetigungszeile mit "Rueckgaengig".
 *
 * Die Leiste kennt den Inhalt nicht: sie merkt ihn in der Zwischenablage (zwischenablage.ts) und gibt
 * ihn beim Einfuegen an die Komponente zurueck. Geschrieben wird nur ueber die Komponente, also ins
 * Formular ("Speichern" der Instanz uebernimmt, "Schliessen" verwirft).
 *
 *  - Einfuegen ist grau, solange die Zwischenablage leer ist oder etwas anderer Art haelt; der Hinweis
 *    am Knopf sagt, warum.
 *  - Zuruecksetzen heisst am Geraet "Vorlage uebernehmen" (sofort, mit Rueckgaengig) und in der Vorlage
 *    "Auf die Werksvorgabe zuruecksetzen" - dort mit einer Sicherheitsabfrage in der Leiste selbst, ohne
 *    Browser-Dialog.
 */
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Box, Button, SvgIcon, Tooltip } from '@mui/material';

import { abonnieren, gemerkt, kopieren, lesen, type Art } from './zwischenablage';
import { wt, type Schluessel } from './Werkzeugleiste.texte';

export interface WerkzeugleisteProps {
    /** Art des Inhalts - nur Kopien derselben Art lassen sich einfuegen */
    art: Art;
    /** was "Kopieren" merkt (muss sich als JSON schreiben lassen) */
    inhalt: unknown;
    /**
     * uebernimmt eine Kopie; `false` heisst "passt hier nicht" (dann aendert sich nichts). Schreibt die
     * Komponente sofort (Wochenplan eines Geraets), gibt sie ein Promise zurueck: die Bestaetigung
     * erscheint erst, wenn es gelungen ist - `false` heisst dann "nicht geschrieben", die Komponente
     * zeigt den Grund selbst.
     */
    onEinfuegen: (inhalt: unknown) => void | boolean | Promise<void | boolean>;
    /** Geraet: wieder die Vorlage verwenden; Vorlage: Werksvorgabe (Promise wie bei onEinfuegen) */
    onZuruecksetzen: () => void | boolean | Promise<void | boolean>;
    /** Erklaerung am Zuruecksetzen-Knopf (leer: allgemeiner Text) */
    zuruecksetzenText?: string;
    /** Frage der Sicherheitsabfrage in der Vorlage (leer: "Wirklich auf die Werksvorgabe zuruecksetzen?") */
    frageText?: string;
    /** Bestaetigung nach dem Zuruecksetzen (leer: "Es gilt wieder die Vorlage." bzw. "... Werksvorgabe ...") */
    zurueckMeldung?: string;
    /** true: die Leiste gehoert zur globalen Vorlage (Zuruecksetzen = Werksvorgabe, mit Abfrage) */
    istVorlage: boolean;
    /** Geraet: es gibt nichts Eigenes - "Auf die Vorlage zuruecksetzen" ist dann ausgegraut */
    nichtsEigen?: boolean;
    /** Herkunft fuer die Kopie, z. B. der Name des Geraets */
    quelle: string;
    sprache: string;
    /**
     * Zusatz: Stand fuer "Rueckgaengig", falls er sich vom kopierten Inhalt unterscheidet (z. B. "leer =
     * es gilt die Vorlage"). Fehlt er, merkt die Leiste `inhalt` und nimmt mit `onEinfuegen` zurueck.
     */
    stand?: unknown;
    onRueckgaengig?: (stand: unknown) => void | boolean | Promise<void | boolean>;
}

const symbol = (pfad: string) =>
    function Symbol(): React.JSX.Element {
        return (
            <SvgIcon fontSize="small">
                <path d={pfad} />
            </SvgIcon>
        );
    };
const KopierenIcon = symbol(
    'M16 1H4c-1.1 0-2 .9-2 2v14h2V3h12zm3 4H8c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h11c1.1 0 2-.9 2-2V7c0-1.1-.9-2-2-2m0 16H8V7h11z',
);
const EinfuegenIcon = symbol(
    'M19 2h-4.18C14.4.84 13.3 0 12 0S9.6.84 9.18 2H5c-1.1 0-2 .9-2 2v16c0 1.1.9 2 2 2h14c1.1 0 2-.9 2-2V4c0-1.1-.9-2-2-2m-7 0c.55 0 1 .45 1 1s-.45 1-1 1-1-.45-1-1 .45-1 1-1m7 18H5V4h2v3h10V4h2z',
);
const ZurueckIcon = symbol(
    'M12 5V2L8 6l4 4V7c3.31 0 6 2.69 6 6 0 2.97-2.17 5.43-5 5.91v2.02c3.95-.49 7-3.85 7-7.93 0-4.42-3.58-8-8-8m-6 8c0-1.65.67-3.15 1.76-4.24L6.34 7.34C4.9 8.79 4 10.79 4 13c0 4.08 3.05 7.44 7 7.93v-2.02c-2.83-.48-5-2.94-5-5.91',
);
const RueckgaengigIcon = symbol(
    'M12.5 8c-2.65 0-5.05.99-6.9 2.6L2 7v9h9l-3.62-3.62c1.39-1.16 3.16-1.88 5.12-1.88 3.54 0 6.55 2.31 7.6 5.5l2.37-.78C21.08 11.03 17.15 8 12.5 8',
);

const kopie = <T,>(wert: T): T => (wert === undefined ? wert : (JSON.parse(JSON.stringify(wert)) as T));

interface Meldung {
    text: string;
    /** Stand vor der Aenderung - vorhanden heisst: "Rueckgaengig" wird angeboten */
    vorher?: { stand: unknown };
}

/** Wie lange die Bestaetigungszeile stehen bleibt (ms): mit Rueckgaengig laenger als ein blosses "Kopiert". */
const DAUER = { kurz: 3500, lang: 12000 };

export function Werkzeugleiste(props: WerkzeugleisteProps): React.JSX.Element {
    const { art, sprache } = props;
    const t = (schluessel: Schluessel, ...werte: (string | number)[]): string => wt(sprache, schluessel, ...werte);
    // die Zwischenablage aendert sich auch von anderen Komponenten aus - neu zeichnen, wenn sie sich meldet
    const [, setZaehler] = useState(0);
    useEffect(() => abonnieren(() => setZaehler(n => n + 1)), []);
    const [meldung, setMeldung] = useState<Meldung | null>(null);
    const [frage, setFrage] = useState(false);
    const uhr = useRef<ReturnType<typeof setTimeout> | null>(null);
    const zeigen = useCallback((m: Meldung | null) => {
        if (uhr.current) {
            clearTimeout(uhr.current);
            uhr.current = null;
        }
        setMeldung(m);
        if (m) {
            uhr.current = setTimeout(() => setMeldung(null), m.vorher ? DAUER.lang : DAUER.kurz);
        }
    }, []);
    const lebt = useRef(true);
    useEffect(() => {
        lebt.current = true;
        return () => {
            lebt.current = false;
            if (uhr.current) {
                clearTimeout(uhr.current);
            }
        };
    }, []);

    const vorhanden = lesen(art);
    const anderes = vorhanden ? null : gemerkt();
    const stand = (): { stand: unknown } => ({ stand: kopie(props.onRueckgaengig ? props.stand : props.inhalt) });

    const kopiereJetzt = (): void => {
        kopieren(art, kopie(props.inhalt), props.quelle);
        setFrage(false);
        zeigen({ text: t('kopiert') });
    };
    /**
     * Fuehrt eine Aenderung aus und zeigt die Bestaetigung erst, wenn sie gelungen ist. Eine Komponente,
     * die sofort schreibt, antwortet mit einem Promise: scheitert das Schreiben (`false`), bleibt die
     * Leiste still - sonst staende "Eingefuegt" neben der Fehlermeldung der Komponente.
     */
    const ausfuehren = (tat: () => void | boolean | Promise<void | boolean>, gut: Meldung, passtNicht: boolean): void => {
        setFrage(false);
        const ergebnis = tat();
        if (ergebnis && typeof (ergebnis as Promise<void | boolean>).then === 'function') {
            zeigen(null);
            (ergebnis as Promise<void | boolean>).then(
                ok => (lebt.current ? zeigen(ok === false ? null : gut) : undefined),
                () => (lebt.current ? zeigen(null) : undefined),
            );
            return;
        }
        zeigen(ergebnis === false ? (passtNicht ? { text: t('passtNicht') } : null) : gut);
    };
    const fuegeEin = (): void => {
        const k = lesen(art);
        if (!k) {
            return;
        }
        const vorher = stand();
        ausfuehren(
            () => props.onEinfuegen(kopie(k.inhalt)),
            { text: k.quelle ? t('eingefuegtAus', k.quelle) : t('eingefuegt'), vorher },
            true,
        );
    };
    const setzeZurueck = (): void => {
        const vorher = stand();
        ausfuehren(
            () => props.onZuruecksetzen(),
            { text: props.zurueckMeldung || t(props.istVorlage ? 'giltWerk' : 'giltVorlage'), vorher },
            false,
        );
    };
    const nimmZurueck = (): void => {
        if (!meldung || !meldung.vorher) {
            return;
        }
        const vorher = meldung.vorher.stand;
        ausfuehren(
            () => (props.onRueckgaengig ? props.onRueckgaengig(vorher) : props.onEinfuegen(vorher)),
            { text: t('zurueckgenommen') },
            false,
        );
    };

    const tipEinfuegen = vorhanden
        ? vorhanden.quelle
            ? t('tipEinfuegenAus', vorhanden.quelle)
            : t('tipEinfuegen')
        : anderes
          ? t('tipAndere', t(`art_${anderes.art}`))
          : t('tipLeer');
    const tipZurueck =
        !props.istVorlage && props.nichtsEigen === true
            ? t('tipNichtsEigen')
            : props.zuruecksetzenText || t(props.istVorlage ? 'tipWerk' : 'tipVorlage');

    return (
        <Box
            className="fk-werkzeug"
            data-art={art}
            sx={{
                display: 'flex',
                flexWrap: 'wrap',
                alignItems: 'center',
                columnGap: 0.5,
                rowGap: 0.25,
                '& .fk-wz-knopf': { textTransform: 'none', minWidth: 0, px: 1, lineHeight: 1.4 },
                '& .fk-wz-zeile': {
                    flex: '1 1 100%',
                    display: 'flex',
                    flexWrap: 'wrap',
                    alignItems: 'center',
                    gap: 0.75,
                    px: 1,
                    py: 0.25,
                    borderRadius: '6px',
                    fontSize: '0.875rem',
                    backgroundColor: 'action.hover',
                },
                '& .fk-wz-frage': { border: '1px solid', borderColor: 'warning.main' },
            }}
        >
            <Tooltip
                disableInteractive
                title={t('tipKopieren')}>
                <Button
                    className="fk-wz-knopf fk-wz-kopieren"
                    size="small"
                    color="inherit"
                    startIcon={<KopierenIcon />}
                    onClick={kopiereJetzt}
                >
                    {t('kopieren')}
                </Button>
            </Tooltip>
            <Tooltip
                disableInteractive
                title={tipEinfuegen}>
                {/* ein gesperrter Knopf meldet keine Mausereignisse - der Hinweis haengt deshalb an der Huelle */}
                <span className="fk-wz-huelle">
                    <Button
                        className="fk-wz-knopf fk-wz-einfuegen"
                        size="small"
                        color="inherit"
                        startIcon={<EinfuegenIcon />}
                        disabled={!vorhanden}
                        onClick={fuegeEin}
                    >
                        {t('einfuegen')}
                    </Button>
                </span>
            </Tooltip>
            <Tooltip
                disableInteractive
                title={tipZurueck}>
                {/* ein gesperrter Knopf meldet keine Mausereignisse - der Hinweis haengt deshalb an der Huelle */}
                <span>
                    <Button
                        className="fk-wz-knopf fk-wz-zurueck"
                        size="small"
                        color="inherit"
                        startIcon={<ZurueckIcon />}
                        disabled={!props.istVorlage && props.nichtsEigen === true}
                        aria-expanded={props.istVorlage ? frage : undefined}
                        onClick={() => {
                            if (props.istVorlage) {
                                zeigen(null);
                                setFrage(f => !f);
                            } else {
                                setzeZurueck();
                            }
                        }}
                    >
                        {/* Verb + Objekt: "Auf die Werksvorgabe zuruecksetzen" statt nur "Werksvorgabe" */}
                        {/* Geraet: Kennlinie und Stufen fallen auf die Vorlage zurueck; ein Wochenplan wird kopiert */}
                        {t(props.istVorlage ? 'tipWerk' : props.art === 'wochenplan' ? 'vorlage' : 'zurVorlage')}
                    </Button>
                </span>
            </Tooltip>
            {frage ? (
                <div
                    className="fk-wz-zeile fk-wz-frage"
                    role="group"
                    aria-label={t('werk')}
                    onKeyDown={e => {
                        if (e.key === 'Escape') {
                            e.stopPropagation();
                            setFrage(false);
                        }
                    }}
                >
                    <span>{props.frageText || t('frageWerk')}</span>
                    <Button
                        className="fk-wz-knopf fk-wz-ja"
                        size="small"
                        variant="contained"
                        color="warning"
                        onClick={setzeZurueck}
                    >
                        {t('ja')}
                    </Button>
                    <Button
                        className="fk-wz-knopf fk-wz-nein"
                        size="small"
                        color="inherit"
                        autoFocus
                        onClick={() => setFrage(false)}
                    >
                        {t('nein')}
                    </Button>
                </div>
            ) : null}
            {meldung && !frage ? (
                <div
                    className="fk-wz-zeile fk-wz-meldung"
                    role="status"
                >
                    <span>{meldung.text}</span>
                    {meldung.vorher ? (
                        <Button
                            className="fk-wz-knopf fk-wz-rueck"
                            size="small"
                            color="primary"
                            startIcon={<RueckgaengigIcon />}
                            onClick={nimmZurueck}
                        >
                            {t('rueckgaengig')}
                        </Button>
                    ) : null}
                </div>
            ) : null}
        </Box>
    );
}

export default Werkzeugleiste;
