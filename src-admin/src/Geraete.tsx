/*
 * Geraeteliste der Regelung als Karten: je Anlage eine eigene, abgesetzte Karte mit kraeftiger Kopfzeile
 * (Symbol, Name, "Individuell" oder "Folgt der Vorlage") - die Standardliste des Admins (accordion) zeichnet
 * alle Eintraege als einen zusammenhaengenden Block und laesst sich ueber das Schema nicht gestalten.
 *
 * Die Felder einer Zeile zeichnet weiter der Admin selbst (ConfigPanel aus @iobroker/json-config, genau wie
 * im accordion): Auswahlfelder, Objektauswahl der Fuehler, Live-Werte und die eigenen Komponenten
 * (Kennlinie, Stufen) arbeiten unveraendert. Die Felder stehen im Schema unter `custom.items` (Liste wie
 * beim accordion, jedes Feld mit `attr`), weil das Schema der jsonConfig an `type: custom` kein `items` kennt.
 *
 * Geschrieben wird nur ins Formular (das Attribut der Liste, z. B. regelGeraete). Name und Verbindung der
 * Anlagen kommen vom Adapter (sendTo regelUebersicht) und sind nur Anzeige.
 */
import React from 'react';
import { Box, Button, Collapse, IconButton, Tooltip, Typography } from '@mui/material';
import { I18n } from '@iobroker/gui-components';
import { ConfigGeneric, ConfigPanel, type ConfigGenericProps, type ConfigGenericState } from '@iobroker/json-config';

import { t as text, type Schluessel } from './Geraete.texte';

type Zeile = Record<string, unknown>;
interface Feld {
    attr?: string;
    default?: unknown;
    [schluessel: string]: unknown;
}
interface Uebersicht {
    id: string;
    name: string;
    online?: boolean;
}
interface Zustand extends ConfigGenericState {
    zeilen?: Zeile[];
    offen: number;
    /** waechst bei jedem Umsortieren/Entfernen, damit die Felder der Zeilen neu aufgebaut werden */
    lauf: number;
    fehler: Record<number, Record<string, string>>;
    frage: number;
    uebersicht: Uebersicht[] | null;
    /** eingelesene Datei, die auf die Entscheidung "ersetzen / hinzufuegen" wartet - oder ihr Fehler */
    einfuhr: { datei: string; zeilen?: Zeile[]; ignoriert?: number; fehler?: boolean } | null;
}

const kopie = <T,>(v: T): T => JSON.parse(JSON.stringify(v));

/** Symbol einer Klimaanlage (Innengeraet mit Luftstrom). */
function AnlageSymbol(): React.JSX.Element {
    return (
        <svg
            className="fk-g-symbol"
            viewBox="0 0 24 24"
            aria-hidden="true"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.7"
            strokeLinecap="round"
            strokeLinejoin="round"
        >
            <rect
                x="3"
                y="5"
                width="18"
                height="8"
                rx="2"
            />
            <path d="M6.5 10h11M8 16.5c0 1-.6 1.6-1.4 2.2M12 16.5v2.7M16 16.5c0 1 .6 1.6 1.4 2.2" />
        </svg>
    );
}

function Zeichen(props: { d: string }): React.JSX.Element {
    return (
        <svg
            viewBox="0 0 24 24"
            width="20"
            height="20"
            aria-hidden="true"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
        >
            <path d={props.d} />
        </svg>
    );
}
const D = {
    plus: 'M12 5v14M5 12h14',
    auf: 'M6 9l6 6 6-6',
    hoch: 'M12 19V5M6 11l6-6 6 6',
    runter: 'M12 5v14M6 13l6 6 6-6',
    kopie: 'M9 9h10v10H9zM5 15V5h10',
    weg: 'M5 7h14M10 7V4h4v3M7 7l1 13h8l1-13',
    export: 'M12 4v11M7 10l5 5 5-5M5 20h14',
    einfuhr: 'M12 15V4M7 9l5-5 5 5M5 20h14',
};

class Geraete extends ConfigGeneric<ConfigGenericProps, Zustand> {
    tippTakt: ReturnType<typeof setTimeout> | null = null;
    takt: ReturnType<typeof setInterval> | null = null;
    lebt = false;
    gemeldet = '';
    datei = React.createRef<HTMLInputElement>();

    /** Angaben unter `custom` des Schemas (direkt am Eintrag werden sie ebenfalls verstanden) */
    angaben(): { items: Feld[]; titleAttr: string } {
        const roh = (this.props.schema || {}) as unknown as Record<string, unknown>;
        const a = { ...roh, ...((roh.custom as Record<string, unknown>) || {}) };
        return {
            items: Array.isArray(a.items) ? (a.items as Feld[]) : [],
            titleAttr: typeof a.titleAttr === 'string' && a.titleAttr ? a.titleAttr : 'geraet',
        };
    }

    async componentDidMount(): Promise<void> {
        await super.componentDidMount();
        const wert = ConfigGeneric.getValue(this.props.data, this.props.attr as string);
        this.setState({
            zeilen: Array.isArray(wert) ? kopie(wert) : [],
            offen: -1,
            lauf: 0,
            fehler: {},
            frage: -1,
            uebersicht: null,
            einfuhr: null,
        });
        this.lebt = true;
        this.fragen();
        this.takt = setInterval(() => this.fragen(), 30000);
    }

    componentDidUpdate(vorher: ConfigGenericProps): void {
        if (vorher.alive !== this.props.alive) {
            this.fragen();
        }
        // Stand des Formulars von aussen ersetzt (z. B. "Verwerfen" des Admins): die Liste folgt
        const wert = ConfigGeneric.getValue(this.props.data, this.props.attr as string);
        const alt = ConfigGeneric.getValue(vorher.data, vorher.attr as string);
        if (wert !== alt && !this.tippTakt && this.state.zeilen && Array.isArray(wert)) {
            if (JSON.stringify(wert) !== JSON.stringify(this.state.zeilen)) {
                const gleichLang = wert.length === this.state.zeilen.length;
                this.setState({
                    zeilen: kopie(wert),
                    lauf: this.state.lauf + 10000,
                    offen: gleichLang ? this.state.offen : -1,
                    fehler: {},
                    frage: -1,
                });
            }
        }
    }

    componentWillUnmount(): void {
        this.lebt = false;
        if (this.tippTakt) {
            clearTimeout(this.tippTakt);
            this.tippTakt = null;
        }
        if (this.takt) {
            clearInterval(this.takt);
            this.takt = null;
        }
        if (this.gemeldet) {
            this.gemeldet = '';
            this.onError(this.props.attr, undefined);
        }
        super.componentWillUnmount?.();
    }

    /** Namen und Verbindung der Anlagen vom Adapter - nur fuer die Kopfzeile */
    fragen(): void {
        const socket = this.props.oContext?.socket;
        if (!this.props.alive || !socket || typeof socket.sendTo !== 'function') {
            if (this.lebt && this.state.uebersicht) {
                this.setState({ uebersicht: null });
            }
            return;
        }
        const ziel = `${this.props.oContext.adapterName}.${this.props.oContext.instance}`;
        Promise.resolve(socket.sendTo(ziel, 'regelUebersicht', {}))
            .then((antwort: any) => {
                if (this.lebt) {
                    this.setState({
                        uebersicht: antwort && !antwort.error && Array.isArray(antwort.geraete) ? antwort.geraete : null,
                    });
                }
            })
            .catch(() => this.lebt && this.setState({ uebersicht: null }));
    }

    /** reicht die Liste ans Formular weiter - gebuendelt, damit Tippen in einem Feld nicht jedes Zeichen meldet */
    schreiben(zeilen: Zeile[]): void {
        if (this.tippTakt) {
            clearTimeout(this.tippTakt);
        }
        this.tippTakt = setTimeout(() => {
            this.tippTakt = null;
            if (this.props.attr) {
                void this.onChange(this.props.attr, zeilen);
            }
        }, 300);
    }

    setzen(teil: Partial<Zustand>, zeilen: Zeile[]): void {
        this.setState({ ...teil, zeilen } as Zustand, () => {
            this.fehlerMelden();
            this.schreiben(zeilen);
        });
    }

    /** ein gemeinsamer Fehler fuer die ganze Liste (die Fehlerliste des Formulars kennt nur Attributnamen) */
    fehlerMelden(): void {
        const hat = Object.values(this.state.fehler).some(f => Object.keys(f).length > 0);
        const meldung = hat ? text(I18n.getLanguage(), 'fehler') : '';
        if (meldung !== this.gemeldet) {
            this.gemeldet = meldung;
            this.onError(this.props.attr, meldung || undefined);
        }
    }

    zeilenFehler = (nr: number) => (attr: string | undefined, fehler?: string) => {
        if (!attr) {
            return;
        }
        this.setState(
            alt => {
                const alle = { ...alt.fehler };
                const eigene = { ...alle[nr] };
                if (fehler) {
                    eigene[attr] = fehler;
                } else {
                    delete eigene[attr];
                }
                if (Object.keys(eigene).length) {
                    alle[nr] = eigene;
                } else {
                    delete alle[nr];
                }
                return { fehler: alle };
            },
            () => this.fehlerMelden(),
        );
    };

    /** Fehler wandern mit ihren Zeilen */
    fehlerUmordnen(neu: (nr: number) => number | null): Record<number, Record<string, string>> {
        const ergebnis: Record<number, Record<string, string>> = {};
        for (const [nr, f] of Object.entries(this.state.fehler)) {
            const ziel = neu(Number(nr));
            if (ziel !== null) {
                ergebnis[ziel] = f;
            }
        }
        return ergebnis;
    }

    hinzufuegen = (): void => {
        const zeilen = kopie(this.state.zeilen || []);
        const neu: Zeile = {};
        for (const feld of this.angaben().items) {
            if (feld.attr) {
                neu[feld.attr] = feld.default ?? null;
            }
        }
        zeilen.push(neu);
        this.setzen({ offen: zeilen.length - 1, frage: -1 }, zeilen);
    };

    entfernen = (nr: number): void => {
        const zeilen = kopie(this.state.zeilen || []);
        zeilen.splice(nr, 1);
        this.setzen(
            {
                offen: -1,
                frage: -1,
                lauf: this.state.lauf + 10000,
                fehler: this.fehlerUmordnen(i => (i === nr ? null : i > nr ? i - 1 : i)),
            },
            zeilen,
        );
    };

    kopieren = (nr: number): void => {
        const zeilen = kopie(this.state.zeilen || []);
        zeilen.splice(nr + 1, 0, kopie(zeilen[nr]));
        this.setzen(
            {
                offen: nr + 1,
                frage: -1,
                lauf: this.state.lauf + 10000,
                fehler: this.fehlerUmordnen(i => (i > nr ? i + 1 : i)),
            },
            zeilen,
        );
    };

    schieben = (nr: number, um: -1 | 1): void => {
        const zeilen = kopie(this.state.zeilen || []);
        const ziel = nr + um;
        if (ziel < 0 || ziel >= zeilen.length) {
            return;
        }
        [zeilen[nr], zeilen[ziel]] = [zeilen[ziel], zeilen[nr]];
        this.setzen(
            {
                offen: this.state.offen === nr ? ziel : this.state.offen === ziel ? nr : this.state.offen,
                frage: -1,
                lauf: this.state.lauf + 10000,
                fehler: this.fehlerUmordnen(i => (i === nr ? ziel : i === ziel ? nr : i)),
            },
            zeilen,
        );
    };

    /** Namen der gespeicherten Felder einer Zeile (ohne die reinen Anzeigefelder, die mit "_" beginnen) */
    feldNamen(): Set<string> {
        return new Set(
            this.angaben()
                .items.map(f => f.attr || '')
                .filter(a => a && !a.startsWith('_')),
        );
    }

    /** Geraeteliste als JSON-Datei herunterladen (wie "exportieren" der Standardliste des Admins) */
    exportieren = (): void => {
        const text = JSON.stringify(this.state.zeilen || [], null, 2);
        const blob = new Blob([text], { type: 'application/json' });
        const adresse = URL.createObjectURL(blob);
        const a = document.createElement('a');
        const kontext = this.props.oContext;
        a.href = adresse;
        a.download = `${kontext?.adapterName || 'faikout'}-${kontext?.instance ?? 0}-${this.props.attr || 'liste'}-${new Date().toISOString().slice(0, 10)}.json`;
        document.body.appendChild(a);
        a.click();
        a.remove();
        setTimeout(() => URL.revokeObjectURL(adresse), 1000);
    };

    /** Datei gewaehlt: lesen und pruefen - uebernommen wird erst nach der Rueckfrage im Formular */
    dateiGewaehlt = (ereignis: React.ChangeEvent<HTMLInputElement>): void => {
        const datei = ereignis.target.files?.[0];
        ereignis.target.value = ''; // dieselbe Datei laesst sich noch einmal waehlen
        if (!datei) {
            return;
        }
        const fehler = (): void => {
            if (this.lebt) {
                this.setState({ einfuhr: { datei: datei.name, fehler: true }, frage: -1 });
            }
        };
        if (datei.size > 2000000) {
            fehler();
            return;
        }
        datei
            .text()
            .then(inhalt => {
                const roh: unknown = JSON.parse(inhalt);
                const bekannt = this.feldNamen();
                const { titleAttr } = this.angaben();
                if (!Array.isArray(roh) || !roh.length || roh.length > 200) {
                    throw new Error('keine Liste');
                }
                let ignoriert = 0;
                const zeilen = roh.map(eintrag => {
                    if (!eintrag || typeof eintrag !== 'object' || Array.isArray(eintrag)) {
                        throw new Error('kein Eintrag');
                    }
                    const zeile: Zeile = {};
                    for (const [feld, wert] of Object.entries(eintrag as Zeile)) {
                        if (bekannt.has(feld)) {
                            zeile[feld] = wert;
                        } else {
                            ignoriert++;
                        }
                    }
                    const kennung = zeile[titleAttr];
                    if (!(titleAttr in zeile) || (kennung !== null && typeof kennung !== 'string')) {
                        throw new Error('ohne Geraet');
                    }
                    return zeile;
                });
                if (this.lebt) {
                    this.setState({ einfuhr: { datei: datei.name, zeilen, ignoriert }, frage: -1 });
                }
            })
            .catch(fehler);
    };

    /** Rueckfrage beantwortet: eingelesene Zeilen ersetzen die Liste oder kommen dazu */
    einfuegen = (ersetzen: boolean): void => {
        const neu = this.state.einfuhr?.zeilen;
        if (!neu) {
            return;
        }
        const zeilen = ersetzen ? kopie(neu) : [...kopie(this.state.zeilen || []), ...kopie(neu)];
        this.setzen({ offen: -1, frage: -1, lauf: this.state.lauf + 10000, fehler: {}, einfuhr: null }, zeilen);
    };

    /** die Felder einer Zeile - gezeichnet vom Admin, wie im accordion */
    felder(zeile: Zeile, nr: number): React.JSX.Element {
        const schema = {
            type: 'panel',
            items: this.angaben().items.reduce((alle: Record<string, Feld>, feld) => {
                if (feld.attr) {
                    alle[feld.attr] = feld;
                }
                return alle;
            }, {}),
            style: { marginLeft: '-8px', marginTop: '6px', marginBottom: '6px' },
        };
        const Panel = ConfigPanel as unknown as React.ComponentType<Record<string, unknown>>;
        return (
            <Panel
                oContext={this.props.oContext}
                index={nr + this.state.lauf}
                arrayIndex={nr}
                changed={this.props.changed}
                expertMode={this.props.expertMode}
                globalData={this.props.data}
                common={this.props.common}
                alive={this.props.alive}
                themeName={this.props.themeName}
                data={zeile}
                custom
                schema={schema}
                originalData={this.props.originalData}
                onChange={(attr: unknown, wert: unknown) => {
                    if (typeof attr === 'string' && attr) {
                        const zeilen = kopie(this.state.zeilen || []);
                        zeilen[nr][attr] = wert;
                        this.setState({ zeilen }, () => this.schreiben(zeilen));
                    }
                }}
                onError={this.zeilenFehler(nr)}
                onHiddenChanged={this.props.onHiddenChanged}
                table={this.props.table}
                customComponents={this.props.customComponents}
            />
        );
    }

    renderItem(): React.JSX.Element | null {
        const { zeilen, offen, uebersicht } = this.state;
        if (!zeilen) {
            return null;
        }
        const sprache = I18n.getLanguage();
        const t = (s: Schluessel, ...w: (string | number)[]): string => text(sprache, s, ...w);
        const { titleAttr } = this.angaben();
        const dunkel = (this.props.oContext?.themeType || this.props.oContext?.theme?.palette?.mode) === 'dark';
        const label = (this.props.schema as { label?: unknown }).label;
        const einfuhr = this.state.einfuhr;
        // Probelauf aller Anlagen (Instanz) - nur ein ausdrueckliches false schaltet ihn ab, wie im Adapter
        const probeAlle = (this.props.data as Record<string, unknown> | undefined)?.regelProbelauf !== false;
        const AKZENT = {
            individuell: dunkel ? '#6cb6e6' : '#1f78b4',
            vorlage: dunkel ? '#6fca83' : '#2e8540',
            leer: dunkel ? '#9a9a9a' : '#8a8a8a',
        };
        return (
            <Box
                className="fk-geraete"
                sx={{
                    width: '100%',
                    color: 'text.primary',
                    '& .fk-g-leiste': { display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: '4px 12px', mb: 1 },
                    '& .fk-g-liste': { display: 'grid', gap: '14px' },
                    '& .fk-g-karte': {
                        border: '1px solid',
                        borderColor: dunkel ? 'rgba(255,255,255,0.22)' : 'rgba(0,0,0,0.2)',
                        borderLeftWidth: 5,
                        borderLeftColor: 'var(--fk-g-akzent)',
                        borderRadius: '10px',
                        backgroundColor: dunkel ? 'rgba(255,255,255,0.03)' : '#fff',
                        boxShadow: dunkel ? '0 1px 3px rgba(0,0,0,0.5)' : '0 1px 3px rgba(0,0,0,0.12)',
                        overflow: 'hidden',
                        minWidth: 0,
                    },
                    '& .fk-g-karte.fk-offen': {
                        boxShadow: dunkel ? '0 3px 12px rgba(0,0,0,0.6)' : '0 3px 12px rgba(0,0,0,0.16)',
                    },
                    '& .fk-g-kopf': {
                        all: 'unset',
                        boxSizing: 'border-box',
                        display: 'flex',
                        alignItems: 'center',
                        gap: '10px',
                        width: '100%',
                        minHeight: 52,
                        padding: '8px 12px',
                        cursor: 'pointer',
                        backgroundColor: dunkel ? 'rgba(255,255,255,0.07)' : 'rgba(0,0,0,0.045)',
                    },
                    '& .fk-g-kopf:hover': { backgroundColor: dunkel ? 'rgba(255,255,255,0.12)' : 'rgba(0,0,0,0.08)' },
                    '& .fk-g-kopf:focus-visible': { outline: '2px solid', outlineColor: 'primary.main', outlineOffset: '-2px' },
                    '& .fk-g-karte.fk-offen .fk-g-kopf': {
                        borderBottom: '1px solid',
                        borderBottomColor: dunkel ? 'rgba(255,255,255,0.16)' : 'rgba(0,0,0,0.14)',
                    },
                    '& .fk-g-symbol': { flex: '0 0 auto', width: 28, height: 28, color: 'var(--fk-g-akzent)' },
                    '& .fk-g-titel': { flex: '1 1 auto', minWidth: 0, display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: '2px 10px' },
                    '& .fk-g-name': { fontWeight: 700, fontSize: '1.08rem', lineHeight: 1.25, overflowWrap: 'anywhere' },
                    '& .fk-g-name.fk-g-ohne': { fontWeight: 500, fontStyle: 'italic', color: 'text.secondary' },
                    '& .fk-g-marken': { display: 'flex', flexWrap: 'wrap', gap: '4px 6px' },
                    '& .fk-g-marke': {
                        fontSize: '0.75rem',
                        fontWeight: 600,
                        lineHeight: 1.5,
                        padding: '0 8px',
                        borderRadius: '10px',
                        border: '1.5px solid',
                        whiteSpace: 'nowrap',
                    },
                    '& .fk-g-marke-art': { color: 'var(--fk-g-akzent)' },
                    '& .fk-g-marke-neben': { color: 'text.secondary', fontWeight: 500 },
                    '& .fk-g-marke-fehler': { color: 'error.main' },
                    '& .fk-g-marke-probe': { color: dunkel ? '#f0b04a' : '#a86a00' },
                    '& .fk-g-knoepfe': { display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: '8px 10px', mt: 1.5 },
                    '& .fk-g-knoepfe .MuiButton-root': { textTransform: 'none' },
                    '& .fk-g-einfuhr': {
                        mt: 1.5,
                        border: '1px solid',
                        borderColor: dunkel ? '#f0b04a' : '#d98a00',
                        borderRadius: '8px',
                        padding: '10px 12px',
                        backgroundColor: 'rgba(217,138,0,0.12)',
                        fontSize: '0.875rem',
                        overflowWrap: 'anywhere',
                    },
                    '& .fk-g-einfuhr.fk-g-einfuhr-fehler': { borderColor: 'error.main', backgroundColor: 'rgba(217,83,79,0.12)' },
                    '& .fk-g-einfuhr-knoepfe': { display: 'flex', flexWrap: 'wrap', gap: '6px 8px', mt: 1 },
                    '& .fk-g-pfeil': { flex: '0 0 auto', display: 'inline-flex', transition: 'transform 0.15s', color: 'text.secondary' },
                    '& .fk-g-karte.fk-offen .fk-g-pfeil': { transform: 'rotate(180deg)' },
                    '& .fk-g-inhalt': { padding: '4px 14px 8px 16px' },
                    '& .fk-g-fuss': {
                        display: 'flex',
                        alignItems: 'center',
                        flexWrap: 'wrap',
                        gap: '2px 4px',
                        borderTop: '1px solid',
                        borderTopColor: 'divider',
                        mt: 0.5,
                        pt: 0.5,
                        minHeight: 40,
                    },
                    '& .fk-g-frage': { display: 'inline-flex', alignItems: 'center', flexWrap: 'wrap', gap: '4px 8px', fontSize: '0.875rem' },
                    '& .fk-g-leer': { color: 'text.secondary', fontSize: '0.875rem', mb: 1 },
                    '@media (max-width: 600px)': { '& .fk-g-inhalt': { padding: '2px 8px 6px 10px' } },
                    '@media (prefers-reduced-motion: reduce)': { '& .fk-g-pfeil': { transition: 'none' } },
                }}
            >
                <div className="fk-g-leiste">
                    {typeof label === 'string' && label ? (
                        <Typography
                            variant="h6"
                            component="div"
                        >
                            {I18n.t(label)}
                        </Typography>
                    ) : null}
                </div>
                {zeilen.length ? null : <div className="fk-g-leer">{t('leer')}</div>}
                <div className="fk-g-liste">
                    {zeilen.map((zeile, nr) => {
                        const kennung = String(zeile[titleAttr] ?? '').trim();
                        const live = uebersicht?.find(u => u.id === kennung || u.name === kennung) || null;
                        const name = live?.name || kennung;
                        const individuell = zeile.individuell === true;
                        const istOffen = offen === nr;
                        const hatFehler = Object.keys(this.state.fehler[nr] || {}).length > 0;
                        const akzent = !kennung ? AKZENT.leer : individuell ? AKZENT.individuell : AKZENT.vorlage;
                        const inhaltId = `fk-g-inhalt-${nr}`;
                        return (
                            <div
                                key={`${nr}_${this.state.lauf}`}
                                className={`fk-g-karte${istOffen ? ' fk-offen' : ''}`}
                                data-geraet={kennung}
                                data-art={individuell ? 'individuell' : 'vorlage'}
                                style={{ '--fk-g-akzent': akzent } as React.CSSProperties}
                            >
                                <button
                                    type="button"
                                    className="fk-g-kopf"
                                    aria-expanded={istOffen}
                                    aria-controls={inhaltId}
                                    title={istOffen ? t('zuklappen') : t('aufklappen')}
                                    onClick={() => this.setState({ offen: istOffen ? -1 : nr, frage: -1 })}
                                >
                                    <AnlageSymbol />
                                    <span className="fk-g-titel">
                                        <span className={`fk-g-name${kennung ? '' : ' fk-g-ohne'}`}>
                                            {name || t('ohneGeraet')}
                                        </span>
                                        <span className="fk-g-marken">
                                            {kennung ? (
                                                <span className="fk-g-marke fk-g-marke-art">
                                                    {individuell ? t('individuell') : t('vorlage')}
                                                </span>
                                            ) : null}
                                            {kennung && (probeAlle || zeile.probelauf === true) ? (
                                                <span className="fk-g-marke fk-g-marke-probe">{t('probelauf')}</span>
                                            ) : null}
                                            {zeile.betrieb === 'faikout' ? (
                                                <span className="fk-g-marke fk-g-marke-neben">{t('faikoutAuto')}</span>
                                            ) : null}
                                            {live && live.online === false ? (
                                                <span className="fk-g-marke fk-g-marke-neben">{t('offline')}</span>
                                            ) : null}
                                            {hatFehler ? (
                                                <span className="fk-g-marke fk-g-marke-fehler">{t('fehler')}</span>
                                            ) : null}
                                        </span>
                                    </span>
                                    <span className="fk-g-pfeil">
                                        <Zeichen d={D.auf} />
                                    </span>
                                </button>
                                <Collapse
                                    in={istOffen}
                                    unmountOnExit
                                    timeout={150}
                                >
                                    <div
                                        className="fk-g-inhalt"
                                        id={inhaltId}
                                    >
                                        {this.felder(zeile, nr)}
                                        <div className="fk-g-fuss">
                                            {this.state.frage === nr ? (
                                                <span className="fk-g-frage">
                                                    {t('entfernenFrage', name || t('ohneGeraet'))}
                                                    <Button
                                                        size="small"
                                                        color="error"
                                                        variant="contained"
                                                        className="fk-g-ja"
                                                        onClick={() => this.entfernen(nr)}
                                                    >
                                                        {t('ja')}
                                                    </Button>
                                                    <Button
                                                        size="small"
                                                        color="inherit"
                                                        className="fk-g-nein"
                                                        onClick={() => this.setState({ frage: -1 })}
                                                    >
                                                        {t('nein')}
                                                    </Button>
                                                </span>
                                            ) : (
                                                <>
                                                    <Tooltip title={t('hoch')}>
                                                        <span>
                                                            <IconButton
                                                                size="small"
                                                                className="fk-g-hoch"
                                                                aria-label={t('hoch')}
                                                                disabled={nr === 0}
                                                                onClick={() => this.schieben(nr, -1)}
                                                            >
                                                                <Zeichen d={D.hoch} />
                                                            </IconButton>
                                                        </span>
                                                    </Tooltip>
                                                    <Tooltip title={t('runter')}>
                                                        <span>
                                                            <IconButton
                                                                size="small"
                                                                className="fk-g-runter"
                                                                aria-label={t('runter')}
                                                                disabled={nr === zeilen.length - 1}
                                                                onClick={() => this.schieben(nr, 1)}
                                                            >
                                                                <Zeichen d={D.runter} />
                                                            </IconButton>
                                                        </span>
                                                    </Tooltip>
                                                    <Tooltip title={t('kopieren')}>
                                                        <IconButton
                                                            size="small"
                                                            className="fk-g-kopie"
                                                            aria-label={t('kopieren')}
                                                            onClick={() => this.kopieren(nr)}
                                                        >
                                                            <Zeichen d={D.kopie} />
                                                        </IconButton>
                                                    </Tooltip>
                                                    <Tooltip title={t('entfernen')}>
                                                        <IconButton
                                                            size="small"
                                                            className="fk-g-weg"
                                                            aria-label={t('entfernen')}
                                                            onClick={() => this.setState({ frage: nr })}
                                                        >
                                                            <Zeichen d={D.weg} />
                                                        </IconButton>
                                                    </Tooltip>
                                                </>
                                            )}
                                        </div>
                                    </div>
                                </Collapse>
                            </div>
                        );
                    })}
                </div>
                <div className="fk-g-knoepfe">
                    <Button
                        className="fk-g-hinzu"
                        variant="outlined"
                        size="small"
                        startIcon={<Zeichen d={D.plus} />}
                        onClick={this.hinzufuegen}
                    >
                        {t('hinzufuegen')}
                    </Button>
                    <span style={{ flex: '1 1 auto' }} />
                    <Tooltip title={t('exportTipp')}>
                        <span>
                            <Button
                                className="fk-g-export"
                                color="inherit"
                                size="small"
                                startIcon={<Zeichen d={D.export} />}
                                disabled={!zeilen.length}
                                onClick={this.exportieren}
                            >
                                {t('exportieren')}
                            </Button>
                        </span>
                    </Tooltip>
                    <Tooltip title={t('importTipp')}>
                        <Button
                            className="fk-g-import"
                            color="inherit"
                            size="small"
                            startIcon={<Zeichen d={D.einfuhr} />}
                            onClick={() => this.datei.current?.click()}
                        >
                            {t('importieren')}
                        </Button>
                    </Tooltip>
                    <input
                        ref={this.datei}
                        className="fk-g-datei"
                        type="file"
                        accept=".json,application/json"
                        hidden
                        onChange={this.dateiGewaehlt}
                    />
                </div>
                {einfuhr ? (
                    <div
                        className={`fk-g-einfuhr${einfuhr.fehler ? ' fk-g-einfuhr-fehler' : ''}`}
                        role={einfuhr.fehler ? 'alert' : 'group'}
                    >
                        {einfuhr.fehler || !einfuhr.zeilen ? (
                            <>
                                <div>{t('importFehler', einfuhr.datei)}</div>
                                <div className="fk-g-einfuhr-knoepfe">
                                    <Button
                                        size="small"
                                        color="inherit"
                                        className="fk-g-einfuhr-zu"
                                        onClick={() => this.setState({ einfuhr: null })}
                                    >
                                        {t('schliessen')}
                                    </Button>
                                </div>
                            </>
                        ) : (
                            <>
                                <div>
                                    {t(
                                        'importFrage',
                                        einfuhr.datei,
                                        einfuhr.zeilen.length,
                                        einfuhr.zeilen
                                            .map(z => {
                                                const k = String(z[titleAttr] ?? '').trim();
                                                return uebersicht?.find(u => u.id === k || u.name === k)?.name || k || t('ohneGeraet');
                                            })
                                            .join(', '),
                                    )}{' '}
                                    {einfuhr.ignoriert ? `${t('importIgnoriert', einfuhr.ignoriert)} ` : ''}
                                    {t('importHinweis')}
                                </div>
                                <div className="fk-g-einfuhr-knoepfe">
                                    <Button
                                        size="small"
                                        variant="contained"
                                        color="warning"
                                        className="fk-g-einfuhr-ersetzen"
                                        onClick={() => this.einfuegen(true)}
                                    >
                                        {t('importErsetzen', zeilen.length)}
                                    </Button>
                                    <Button
                                        size="small"
                                        variant="outlined"
                                        className="fk-g-einfuhr-anhaengen"
                                        onClick={() => this.einfuegen(false)}
                                    >
                                        {t('importAnhaengen')}
                                    </Button>
                                    <Button
                                        size="small"
                                        color="inherit"
                                        className="fk-g-einfuhr-zu"
                                        onClick={() => this.setState({ einfuhr: null })}
                                    >
                                        {t('nein')}
                                    </Button>
                                </div>
                            </>
                        )}
                    </div>
                ) : null}
            </Box>
        );
    }
}

export default Geraete;
