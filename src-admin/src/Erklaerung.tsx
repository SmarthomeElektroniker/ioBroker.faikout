/*
 * Schaubild der Regelung (nur Anzeige, schreibt nichts):
 *
 *     Zeitplan -> Temperaturstufe (Ziel) -> Regelung (Leistung) -> Anlage
 *
 * mit Handeingriff und Feuchte als Seiteneingriff. Jeder Kasten nennt den Reiter, in dem man ihn
 * einstellt. Breit laeuft die Kette waagerecht, auf schmalen Schirmen senkrecht. Symbole und Pfeile
 * sind SVG, die Kaesten Text - so bricht jede der 11 Sprachen sauber um. Die Farben kommen aus dem
 * Thema des Admins.
 *
 * Die Reiternamen stehen in Erklaerung.texte.ts; heissen die Reiter anders, kann das Schema die
 * i18n-Schluessel der Reiter nennen: `reiterZeitplaene`, `reiterRegelung`.
 */
import React, { useEffect, useRef, useState } from 'react';
import { Box, Typography } from '@mui/material';
import { I18n } from '@iobroker/gui-components';
import { ConfigGeneric, type ConfigGenericProps, type ConfigGenericState } from '@iobroker/json-config';

import { stufenFarben } from './Stufen';
import { t as text, type Schluessel } from './Erklaerung.texte';

/** ab dieser Breite laeuft die Kette waagerecht */
const BREIT_AB = 720;

// Symbole als Pfade (Material Icons)
const SYMBOL = {
    zeitplan:
        'M11.99 2C6.47 2 2 6.48 2 12s4.47 10 9.99 10C17.52 22 22 17.52 22 12S17.52 2 11.99 2M12 20c-4.42 0-8-3.58-8-8s3.58-8 8-8 8 3.58 8 8-3.58 8-8 8m.5-13H11v6l5.25 3.15.75-1.23-4.5-2.67z',
    stufe: 'M15 13V5c0-1.66-1.34-3-3-3S9 3.34 9 5v8c-1.21.91-2 2.37-2 4 0 2.76 2.24 5 5 5s5-2.24 5-5c0-1.63-.79-3.09-2-4m-4-8c0-.55.45-1 1-1s1 .45 1 1h-1v1h1v2h-1v1h1v2h-2z',
    regelung: 'M3.5 18.49l6-6.01 4 4L22 6.92l-1.41-1.41-7.09 7.97-4-4L2 16.99z',
    anlage: 'M22 11h-4.17l3.24-3.24-1.41-1.42L15 11h-2V9l4.66-4.66-1.42-1.41L13 6.17V2h-2v4.17L7.76 2.93 6.34 4.34 11 9v2H9L4.34 6.34 2.93 7.76 6.17 11H2v2h4.17l-3.24 3.24 1.41 1.42L9 13h2v2l-4.66 4.66 1.42 1.41L11 17.83V22h2v-4.17l3.24 3.24 1.42-1.41L13 15v-2h2l4.66 4.66 1.41-1.42L17.83 13H22z',
    hand: 'M9 11.24V7.5C9 6.12 10.12 5 11.5 5S14 6.12 14 7.5v3.74c1.21-.81 2-2.18 2-3.74C16 5.01 13.99 3 11.5 3S7 5.01 7 7.5c0 1.56.79 2.93 2 3.74m9.84 4.63-4.54-2.26c-.17-.07-.35-.11-.54-.11H13v-6c0-.83-.67-1.5-1.5-1.5S10 6.67 10 7.5v10.74l-3.43-.72c-.08-.01-.15-.03-.24-.03-.31 0-.59.13-.79.33l-.79.8 4.94 4.94c.27.27.65.44 1.06.44h6.79c.75 0 1.33-.55 1.44-1.28l.75-5.27c.01-.07.02-.14.02-.2 0-.62-.38-1.16-.91-1.38',
    feuchte: 'M12 2c-5.33 4.55-8 8.48-8 11.8 0 4.98 3.8 8.2 8 8.2s8-3.22 8-8.2c0-3.32-2.67-7.25-8-11.8',
};
type Teil = keyof typeof SYMBOL;

function Symbol(props: { teil: Teil }): React.JSX.Element {
    return (
        <span
            className="fk-e-symbol"
            aria-hidden="true"
        >
            <svg
                viewBox="0 0 24 24"
                width="20"
                height="20"
                fill="currentColor"
            >
                <path d={SYMBOL[props.teil]} />
            </svg>
        </span>
    );
}

/** Pfeil der Kette: nach rechts (breit) bzw. nach unten (schmal). */
function Pfeil(props: { runter: boolean; seite?: boolean }): React.JSX.Element {
    const strich = props.seite ? '4 3' : undefined;
    return props.runter ? (
        <svg
            className={`fk-e-pfeil fk-e-runter${props.seite ? ' fk-e-seitenpfeil' : ''}`}
            viewBox="0 0 20 26"
            width="20"
            height="26"
            aria-hidden="true"
        >
            <path
                d="M10 1v20"
                stroke="currentColor"
                strokeWidth="2"
                strokeDasharray={strich}
                fill="none"
            />
            <path
                d="M4 17l6 7 6-7"
                stroke="currentColor"
                strokeWidth="2"
                fill="none"
                strokeLinecap="round"
                strokeLinejoin="round"
            />
        </svg>
    ) : (
        <svg
            className="fk-e-pfeil fk-e-rechts"
            viewBox="0 0 34 20"
            width="34"
            height="20"
            aria-hidden="true"
        >
            <path
                d="M2 10h27"
                stroke="currentColor"
                strokeWidth="2"
                fill="none"
            />
            <path
                d="M24 4l7 6-7 6"
                stroke="currentColor"
                strokeWidth="2"
                fill="none"
                strokeLinecap="round"
                strokeLinejoin="round"
            />
        </svg>
    );
}

/** Winkelpfeil (schmal): vom Seitenkasten hinauf in den Kasten der Kette darueber. */
function Winkel(): React.JSX.Element {
    return (
        <svg
            className="fk-e-winkel"
            viewBox="0 0 26 40"
            width="26"
            height="40"
            aria-hidden="true"
        >
            <path
                d="M25 30H10V5"
                stroke="currentColor"
                strokeWidth="2"
                strokeDasharray="4 3"
                fill="none"
            />
            <path
                d="M4 10l6-7 6 7"
                stroke="currentColor"
                strokeWidth="2"
                fill="none"
                strokeLinecap="round"
                strokeLinejoin="round"
            />
        </svg>
    );
}

interface AnsichtProps {
    sprache: string;
    dunkel: boolean;
    farben: { flaeche: string; akzent: string };
    /** Namen der Reiter, wie sie im Admin heissen (leer = Text der Komponente) */
    reiterZeitplaene?: string;
    reiterRegelung?: string;
    titel?: string;
}

/** Das Schaubild - ohne jsonConfig, damit es sich einzeln rendern und pruefen laesst. */
export function ErklaerungAnsicht(props: AnsichtProps): React.JSX.Element {
    const { sprache, farben } = props;
    const t = (s: Schluessel, ...w: (string | number)[]): string => text(sprache, s, ...w);
    const rahmen = useRef<HTMLDivElement | null>(null);
    const [platz, setPlatz] = useState(1000);
    useEffect(() => {
        const el = rahmen.current;
        if (!el || typeof ResizeObserver === 'undefined') {
            return undefined;
        }
        const messen = (): void => setPlatz(el.clientWidth || 1000);
        const waechter = new ResizeObserver(messen);
        waechter.observe(el);
        messen();
        return () => waechter.disconnect();
    }, []);
    const breit = platz >= BREIT_AB;

    const tabZeit = t('reiter', props.reiterZeitplaene || t('tabZeitplaene'));
    const tabRegel = t('reiter', props.reiterRegelung || t('tabRegelung'));
    const farbeHand = props.dunkel ? '#d3b56a' : '#8a6a1f';
    const farbeFeuchte = props.dunkel ? '#7fb6e6' : '#2a6aa6';
    const punkte = stufenFarben(['komfort', 'absenken', 'abwesend', 'aus'], props.dunkel);

    const kasten = (
        teil: Teil,
        o: { marke?: string; reiter?: string; seite?: boolean; farbe?: string; zusatz?: React.JSX.Element },
    ): React.JSX.Element => (
        <div
            className={`fk-e-kasten fk-e-${teil}${o.seite ? ' fk-e-seite' : ''}`}
            data-teil={teil}
            style={{ '--fk-e-farbe': o.farbe || farben.akzent } as React.CSSProperties}
        >
            {o.seite && !breit ? <Winkel /> : null}
            <div className="fk-e-kopf">
                <Symbol teil={teil} />
                <span className="fk-e-name">{t(teil)}</span>
                {o.marke ? <span className="fk-e-marke">{o.marke}</span> : null}
                {o.zusatz}
            </div>
            <div className="fk-e-text">{t(`${teil}Text` as Schluessel)}</div>
            {o.reiter ? <div className="fk-e-reiter">{o.reiter}</div> : null}
        </div>
    );

    const hand = kasten('hand', { seite: true, farbe: farbeHand, reiter: tabZeit });
    const feuchte = kasten('feuchte', { seite: true, farbe: farbeFeuchte, reiter: tabRegel });
    const zeitplan = kasten('zeitplan', { reiter: tabZeit });
    const stufe = kasten('stufe', {
        marke: t('stufeMarke'),
        reiter: tabZeit,
        zusatz: (
            <span
                className="fk-e-punkte"
                aria-hidden="true"
            >
                {punkte.map(f => (
                    <i
                        key={f}
                        style={{ background: f }}
                    />
                ))}
            </span>
        ),
    });
    const regelung = kasten('regelung', { marke: t('regelungMarke'), reiter: tabRegel });
    const anlage = kasten('anlage', {});

    return (
        <Box
            ref={rahmen}
            className={`fk-erklaerung ${breit ? 'fk-e-breit' : 'fk-e-schmal'}`}
            role="group"
            aria-label={t('beschreibung')}
            sx={{
                width: '100%',
                maxWidth: 1180,
                color: 'text.primary',
                '& .fk-e-kasten': {
                    position: 'relative',
                    minWidth: 0,
                    boxSizing: 'border-box',
                    border: '1px solid',
                    borderColor: 'divider',
                    borderTop: '3px solid var(--fk-e-farbe)',
                    borderRadius: '10px',
                    background: farben.flaeche,
                    padding: '9px 11px 10px',
                },
                '& .fk-e-seite': {
                    border: '1.5px dashed var(--fk-e-farbe)',
                    background: `color-mix(in srgb, var(--fk-e-farbe) 8%, ${farben.flaeche})`,
                },
                '& .fk-e-kopf': { display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: '4px 8px', mb: '4px' },
                '& .fk-e-symbol': {
                    flex: '0 0 auto',
                    width: 32,
                    height: 32,
                    borderRadius: '50%',
                    display: 'inline-flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    color: 'var(--fk-e-farbe)',
                    background: 'color-mix(in srgb, var(--fk-e-farbe) 16%, transparent)',
                },
                '& .fk-e-name': { fontWeight: 600, fontSize: '1rem', lineHeight: 1.2 },
                '& .fk-e-marke': {
                    fontSize: '0.72rem',
                    fontWeight: 600,
                    letterSpacing: '0.02em',
                    color: 'var(--fk-e-farbe)',
                    border: '1.5px solid var(--fk-e-farbe)',
                    borderRadius: '10px',
                    padding: '0 7px',
                    lineHeight: 1.5,
                    whiteSpace: 'nowrap',
                },
                '& .fk-e-punkte': { display: 'inline-flex', gap: '3px' },
                '& .fk-e-punkte i': { width: 9, height: 9, borderRadius: '50%', display: 'block' },
                '& .fk-e-text': { fontSize: '0.86rem', lineHeight: 1.35, color: 'text.secondary' },
                '& .fk-e-reiter': {
                    display: 'inline-block',
                    mt: '7px',
                    fontSize: '0.76rem',
                    fontWeight: 600,
                    borderBottom: '2px solid var(--fk-e-farbe)',
                    padding: '1px 2px 2px',
                },
                '& .fk-e-pfeil': { display: 'block', opacity: 0.65 },
                '& .fk-e-seitenpfeil': { opacity: 1 },
                // breit: Seiteneingriffe oben, darunter die Kette von links nach rechts
                '&.fk-e-breit .fk-e-netz': {
                    display: 'grid',
                    gridTemplateColumns: 'minmax(0, 1fr) 34px minmax(0, 1fr) 34px minmax(0, 1fr) 34px minmax(0, 1fr)',
                    alignItems: 'stretch',
                    rowGap: 0,
                },
                '&.fk-e-breit .fk-e-hand': { gridColumn: '1 / span 3', gridRow: 1 },
                '&.fk-e-breit .fk-e-feuchte': { gridColumn: '5 / span 3', gridRow: 1 },
                '&.fk-e-breit .fk-e-ab': { gridRow: 2, display: 'flex', justifyContent: 'center', padding: '2px 0' },
                '&.fk-e-breit .fk-e-zu': {
                    gridRow: 3,
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                },
                '&.fk-e-breit .fk-e-kette': { gridRow: 3 },
                // schmal: Kette von oben nach unten, Seiteneingriffe eingerueckt unter ihrem Kasten
                '&.fk-e-schmal .fk-e-netz': { display: 'flex', flexDirection: 'column' },
                '&.fk-e-schmal .fk-e-zu': { display: 'flex', justifyContent: 'center', padding: '3px 0' },
                '&.fk-e-schmal .fk-e-seite': { marginLeft: '34px', marginTop: '8px' },
                '&.fk-e-schmal .fk-e-winkel': { position: 'absolute', left: -31, top: -9, color: 'var(--fk-e-farbe)' },
            }}
        >
            {props.titel ? (
                <Typography
                    variant="h6"
                    component="div"
                    sx={{ fontSize: '1.05rem', mb: 1 }}
                >
                    {props.titel}
                </Typography>
            ) : null}
            {breit ? (
                <div className="fk-e-netz">
                    {hand}
                    {feuchte}
                    <div
                        className="fk-e-ab"
                        style={{ gridColumn: 3, color: farbeHand }}
                    >
                        <Pfeil
                            runter
                            seite
                        />
                    </div>
                    <div
                        className="fk-e-ab"
                        style={{ gridColumn: 7, color: farbeFeuchte }}
                    >
                        <Pfeil
                            runter
                            seite
                        />
                    </div>
                    {[zeitplan, stufe, regelung, anlage].map((k, i) => (
                        <React.Fragment key={i}>
                            {i ? (
                                <div
                                    className="fk-e-zu"
                                    style={{ gridColumn: 2 * i }}
                                >
                                    <Pfeil runter={false} />
                                </div>
                            ) : null}
                            <div
                                className="fk-e-kette"
                                style={{ gridColumn: 2 * i + 1, display: 'flex' }}
                            >
                                {React.cloneElement(k, { style: { ...k.props.style, flex: '1 1 auto' } })}
                            </div>
                        </React.Fragment>
                    ))}
                </div>
            ) : (
                <div className="fk-e-netz">
                    {zeitplan}
                    <div className="fk-e-zu">
                        <Pfeil runter />
                    </div>
                    {stufe}
                    {hand}
                    <div className="fk-e-zu">
                        <Pfeil runter />
                    </div>
                    {regelung}
                    <div className="fk-e-zu">
                        <Pfeil runter />
                    </div>
                    {anlage}
                    {feuchte}
                </div>
            )}
        </Box>
    );
}

/** jsonConfig-Komponente "Erklaerung" (kein Formularwert; `attr` ist nur ein Platzhalter). */
class Erklaerung extends ConfigGeneric<ConfigGenericProps, ConfigGenericState> {
    renderItem(): React.JSX.Element {
        const props = this.props;
        const sprache = I18n.getLanguage();
        const palette = props.oContext?.theme?.palette;
        // eigene Angaben stehen unter `custom` (das Schema der jsonConfig erlaubt keine freien Schluessel)
        const roh = (props.schema || {}) as Record<string, unknown>;
        const schema = { ...roh, ...((roh.custom as Record<string, unknown>) || {}) };
        const name = (schluessel: unknown): string =>
            typeof schluessel === 'string' && schluessel ? I18n.t(schluessel) : '';
        return (
            <ErklaerungAnsicht
                sprache={sprache}
                dunkel={(props.oContext?.themeType || palette?.mode) === 'dark'}
                farben={{
                    flaeche: palette?.background?.paper || '#fff',
                    akzent: palette?.primary?.main || '#3399cc',
                }}
                reiterZeitplaene={name(schema.reiterZeitplaene)}
                reiterRegelung={name(schema.reiterRegelung)}
                titel={typeof schema.label === 'string' && schema.label ? I18n.t(schema.label) : text(sprache, 'titel')}
            />
        );
    }
}

export default Erklaerung;
