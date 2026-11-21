/*
 * Aufklappbarer Abschnitt der Einstellungsseite als KARTE: eigener Rahmen, abgesetzter Hintergrund, links ein
 * Symbol, rechts ein grosser Pfeil, der sich beim Oeffnen dreht; geschlossen zeigt ein Untertitel, was darin
 * gerade eingestellt ist. Die Standardleiste des Admins (`type: panel`, `collapsable`) sieht aus wie ein
 * Trenner und laesst sich ueber das Schema nicht gestalten.
 *
 * Die Felder des Abschnitts zeichnet weiter der Admin selbst (ConfigPanel aus @iobroker/json-config) - mit
 * denselben Daten und demselben onChange wie ein gewoehnliches Panel; die Komponente ist nur die Huelle.
 * Im Schema stehen die Felder unter `custom.items` (wie bei `panel` ein Objekt Name -> Feld), weil das
 * Schema der jsonConfig an `type: custom` kein `items` kennt. Weitere Angaben unter `custom`:
 *   symbol     Name eines Symbols (siehe SYMBOLE)
 *   vorschau   Liste von Teilen des Untertitels: {text, werte?, wenn?}
 *                text   Schluessel der Uebersetzung (admin/i18n), %s der Reihe nach durch `werte` ersetzt
 *                werte  Namen von Feldern; bei Auswahlfeldern erscheint der Text der gewaehlten Option
 *                wenn   Ausdruck ueber `data` - der Teil erscheint nur, wenn er wahr ist
 *   geaendert  Ausdruck ueber `data`: wahr, wenn etwas von der Werksvorgabe abweicht (Etikett "geaendert")
 * Ob der Abschnitt offen ist, merkt sich der Browser (derselbe Schluessel wie beim Panel des Admins).
 */
import React from 'react';
import { Box, Collapse } from '@mui/material';
import { I18n } from '@iobroker/gui-components';
import { ConfigGeneric, ConfigPanel, type ConfigGenericProps, type ConfigGenericState } from '@iobroker/json-config';

import { t as text, type Schluessel } from './Abschnitt.texte';

interface Feld {
    type?: string;
    options?: { label?: string; value?: unknown }[];
    [schluessel: string]: unknown;
}
interface VorschauTeil {
    text?: string;
    werte?: string[];
    wenn?: string;
}
interface Angaben {
    items: Record<string, Feld>;
    symbol: string;
    vorschau: VorschauTeil[];
    geaendert: string;
}
interface Zustand extends ConfigGenericState {
    offen: boolean;
}

/** Symbole (24er-Raster, Linien) - passend zum Inhalt des Abschnitts */
const SYMBOLE: Record<string, string> = {
    regler: 'M4 6h9M17 6h3M4 12h3M11 12h9M4 18h11M19 18h1M15 4v4M9 10v4M17 16v4',
    hand: 'M8 13V5.5a1.5 1.5 0 013 0V11m0-1.5a1.5 1.5 0 013 0V11m0-.5a1.5 1.5 0 013 0V15a6 6 0 01-6 6h-1a6 6 0 01-5-2.7L4.4 14a1.5 1.5 0 012.5-1.6L8 14',
    kiste: 'M3 8l9-5 9 5v8l-9 5-9-5zM3 8l9 5 9-5M12 13v8',
    tempo: 'M4 16a8 8 0 1116 0M12 16l4-5M4 20h16',
    liste: 'M9 6h11M9 12h11M9 18h11M4 6h1.5M4 12h1.5M4 18h1.5',
    kennung: 'M4 6h16v12H4zM8 10v4M11 10h2a2 2 0 010 4h-2zM16.5 10v4',
    tabelle: 'M4 5h16v14H4zM4 10h16M4 15h16M10 5v14',
};

function Zeichen(props: { d: string; groesse: number; klasse?: string }): React.JSX.Element {
    return (
        <svg
            className={props.klasse}
            viewBox="0 0 24 24"
            width={props.groesse}
            height={props.groesse}
            aria-hidden="true"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.8"
            strokeLinecap="round"
            strokeLinejoin="round"
        >
            <path d={props.d} />
        </svg>
    );
}

/** Wertet einen Ausdruck des Schemas ueber die Formulardaten aus (wie `hidden` der jsonConfig); Fehler = falsch */
function wahr(ausdruck: string, data: Record<string, unknown>): boolean {
    if (!ausdruck) {
        return false;
    }
    try {
        // eslint-disable-next-line @typescript-eslint/no-implied-eval
        return !!new Function('data', `return (${ausdruck});`)(data || {});
    } catch {
        return false;
    }
}

class Abschnitt extends ConfigGeneric<ConfigGenericProps, Zustand> {
    angaben(): Angaben {
        const roh = (this.props.schema || {}) as unknown as Record<string, unknown>;
        const a = { ...roh, ...((roh.custom as Record<string, unknown>) || {}) };
        return {
            items: a.items && typeof a.items === 'object' && !Array.isArray(a.items) ? (a.items as Record<string, Feld>) : {},
            symbol: typeof a.symbol === 'string' ? a.symbol : '',
            vorschau: Array.isArray(a.vorschau) ? (a.vorschau as VorschauTeil[]) : [],
            geaendert: typeof a.geaendert === 'string' ? a.geaendert : '',
        };
    }

    merkName(): string {
        return `${this.props.oContext?.adapterName || 'faikout'}.${this.props.attr}`;
    }

    async componentDidMount(): Promise<void> {
        await super.componentDidMount();
        let offen = false;
        try {
            offen = window.localStorage.getItem(this.merkName()) === 'true';
        } catch {
            offen = false;
        }
        this.setState({ offen });
    }

    schalten = (): void => {
        const offen = !this.state.offen;
        try {
            window.localStorage.setItem(this.merkName(), offen ? 'true' : 'false');
        } catch {
            // ohne Speicher des Browsers bleibt der Abschnitt nur fuer diese Sitzung offen
        }
        this.setState({ offen });
    };

    /** Wert eines Feldes, wie ihn ein Mensch liest: Text der gewaehlten Option, Zahl in Landesschreibweise */
    wertText(name: string, sprache: string): string {
        const data = (this.props.data || {}) as Record<string, unknown>;
        const wert = data[name];
        const feld = this.angaben().items[name];
        if (feld && Array.isArray(feld.options)) {
            const option = feld.options.find(o => o.value === wert);
            if (option && typeof option.label === 'string') {
                return I18n.t(option.label);
            }
        }
        if (typeof wert === 'number' && Number.isFinite(wert)) {
            return wert.toLocaleString(sprache, { maximumFractionDigits: 2 });
        }
        return wert === undefined || wert === null ? '' : String(wert).trim();
    }

    vorschau(sprache: string): string {
        const data = (this.props.data || {}) as Record<string, unknown>;
        const teile: string[] = [];
        for (const teil of this.angaben().vorschau) {
            if (!teil || typeof teil.text !== 'string' || (teil.wenn && !wahr(teil.wenn, data))) {
                continue;
            }
            const werte = (teil.werte || []).map(w => this.wertText(w, sprache));
            let n = 0;
            const zeile = I18n.t(teil.text)
                .replace(/%s/g, () => werte[n++] ?? '')
                .trim();
            if (zeile) {
                teile.push(zeile);
            }
        }
        return teile.join(' · ');
    }

    renderItem(): React.JSX.Element | null {
        if (!this.state || typeof this.state.offen !== 'boolean') {
            return null;
        }
        const { offen } = this.state;
        const a = this.angaben();
        const sprache = I18n.getLanguage();
        const t = (s: Schluessel): string => text(sprache, s);
        const dunkel = (this.props.oContext?.themeType || this.props.oContext?.theme?.palette?.mode) === 'dark';
        const label = (this.props.schema as { label?: unknown }).label;
        const titel = typeof label === 'string' && label ? I18n.t(label) : '';
        const unter = offen ? '' : this.vorschau(sprache);
        const geaendert = wahr(a.geaendert, (this.props.data || {}) as Record<string, unknown>);
        const inhaltId = `fk-a-inhalt-${this.props.attr}`;
        const Panel = ConfigPanel as unknown as React.ComponentType<Record<string, unknown>>;
        return (
            <Box
                className={`fk-abschnitt${offen ? ' fk-offen' : ''}`}
                data-abschnitt={this.props.attr}
                sx={{
                    width: '100%',
                    boxSizing: 'border-box',
                    color: 'text.primary',
                    border: '1px solid',
                    borderColor: dunkel ? 'rgba(255,255,255,0.22)' : 'rgba(0,0,0,0.2)',
                    borderRadius: '10px',
                    backgroundColor: dunkel ? 'rgba(255,255,255,0.04)' : 'rgba(0,0,0,0.025)',
                    boxShadow: dunkel ? '0 1px 3px rgba(0,0,0,0.5)' : '0 1px 3px rgba(0,0,0,0.12)',
                    overflow: 'hidden',
                    minWidth: 0,
                    my: 0.5,
                    '&.fk-offen': { boxShadow: dunkel ? '0 3px 12px rgba(0,0,0,0.6)' : '0 3px 12px rgba(0,0,0,0.16)' },
                    '& .fk-a-kopf': {
                        all: 'unset',
                        boxSizing: 'border-box',
                        display: 'flex',
                        alignItems: 'center',
                        gap: '12px',
                        width: '100%',
                        minHeight: 56,
                        padding: '8px 12px 8px 14px',
                        cursor: 'pointer',
                        transition: 'background-color 0.12s',
                    },
                    '& .fk-a-kopf:hover': { backgroundColor: dunkel ? 'rgba(255,255,255,0.09)' : 'rgba(0,0,0,0.06)' },
                    '& .fk-a-kopf:focus-visible': { outline: '2px solid', outlineColor: 'primary.main', outlineOffset: '-2px' },
                    '&.fk-offen .fk-a-kopf': {
                        borderBottom: '1px solid',
                        borderBottomColor: dunkel ? 'rgba(255,255,255,0.16)' : 'rgba(0,0,0,0.14)',
                        backgroundColor: dunkel ? 'rgba(255,255,255,0.06)' : 'rgba(0,0,0,0.04)',
                    },
                    '& .fk-a-symbol': { flex: '0 0 auto', color: 'primary.main' },
                    '& .fk-a-texte': { flex: '1 1 auto', minWidth: 0, display: 'flex', flexDirection: 'column', gap: '1px' },
                    '& .fk-a-zeile': { display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: '2px 10px' },
                    '& .fk-a-titel': { fontWeight: 600, fontSize: '1rem', lineHeight: 1.3, overflowWrap: 'anywhere' },
                    '& .fk-a-unter': {
                        fontSize: '0.8125rem',
                        lineHeight: 1.35,
                        color: 'text.secondary',
                        overflowWrap: 'anywhere',
                        display: '-webkit-box',
                        WebkitLineClamp: 2,
                        WebkitBoxOrient: 'vertical',
                        overflow: 'hidden',
                    },
                    '& .fk-a-marke': {
                        fontSize: '0.75rem',
                        fontWeight: 600,
                        lineHeight: 1.5,
                        padding: '0 8px',
                        borderRadius: '10px',
                        border: '1.5px solid',
                        whiteSpace: 'nowrap',
                        color: dunkel ? '#f0b04a' : '#a86a00',
                    },
                    '& .fk-a-tun': {
                        flex: '0 0 auto',
                        fontSize: '0.8125rem',
                        color: 'text.secondary',
                        opacity: 0,
                        transition: 'opacity 0.12s',
                        whiteSpace: 'nowrap',
                    },
                    '& .fk-a-kopf:hover .fk-a-tun, & .fk-a-kopf:focus-visible .fk-a-tun': { opacity: 1 },
                    '& .fk-a-pfeil': { flex: '0 0 auto', display: 'inline-flex', transition: 'transform 0.18s', color: 'text.secondary' },
                    '&.fk-offen .fk-a-pfeil': { transform: 'rotate(180deg)' },
                    '& .fk-a-inhalt': { padding: '10px 14px 12px 16px' },
                    '@media (max-width: 600px)': {
                        '& .fk-a-inhalt': { padding: '8px 8px 10px 10px' },
                        '& .fk-a-tun': { display: 'none' },
                    },
                    '@media (hover: none)': { '& .fk-a-tun': { display: 'none' } },
                    '@media (prefers-reduced-motion: reduce)': { '& .fk-a-pfeil, & .fk-a-kopf, & .fk-a-tun': { transition: 'none' } },
                }}
            >
                <button
                    type="button"
                    className="fk-a-kopf"
                    aria-expanded={offen}
                    aria-controls={inhaltId}
                    onClick={this.schalten}
                >
                    <Zeichen
                        klasse="fk-a-symbol"
                        d={SYMBOLE[a.symbol] || SYMBOLE.regler}
                        groesse={28}
                    />
                    <span className="fk-a-texte">
                        <span className="fk-a-zeile">
                            <span className="fk-a-titel">{titel}</span>
                            {geaendert ? (
                                <span
                                    className="fk-a-marke"
                                    title={t('geaendertTipp')}
                                >
                                    {t('geaendert')}
                                </span>
                            ) : null}
                        </span>
                        {unter ? <span className="fk-a-unter">{unter}</span> : null}
                    </span>
                    <span className="fk-a-tun">{offen ? t('ausblenden') : t('einblenden')}</span>
                    <span className="fk-a-pfeil">
                        <Zeichen
                            d="M5 8.5l7 7 7-7"
                            groesse={32}
                        />
                    </span>
                </button>
                <Collapse
                    in={offen}
                    timeout={150}
                >
                    <div
                        className="fk-a-inhalt"
                        id={inhaltId}
                    >
                        <Panel
                            {...(this.props as unknown as Record<string, unknown>)}
                            schema={{ type: 'panel', items: a.items }}
                        />
                    </div>
                </Collapse>
            </Box>
        );
    }
}

export default Abschnitt;
