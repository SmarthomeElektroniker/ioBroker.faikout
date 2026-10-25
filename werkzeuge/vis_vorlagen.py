#!/usr/bin/env python3
"""
Erzeugt die VIS-1-Ansichten fuer ioBroker.faikout (Ordner vis-templates/).

Zwei Ausgaben aus demselben Bauplan:
  * Vorlage fuer alle Nutzer (Platzhalter faikout.0.DEVICE_1 / faikout.0.DEVICE_2)
      python3 werkzeuge/vis_vorlagen.py vorlage vis-templates/
  * Fassung fuer eine konkrete Anlage (Geraete und Felder aus einem Objektabzug)
      python3 werkzeuge/vis_vorlagen.py anlage <objekte.json> <ziel.json> \
          --geraet faikout.0.Daikin_1OG=1.OG=Faikout_1OG \
          --geraet faikout.0.Daikin_Wohnzimmer=Wohnzimmer=Faikout_Wohnzimmer [--start-id 300]
    <objekte.json>: {"states":[{"id":..., "unit":...}, ...]} (Abzug der faikout.0-Objekte)

vis-1-Regeln, an die sich alles hier haelt (sonst bricht die Bindung):
  * jede Bindung {var:id;formel} steht auf EINER Zeile; die Formel enthaelt kein ; { }
    (Stilangaben mit Semikolon also nur ausserhalb von Formeln)
  * Variablen kommen als Text an -> parseFloat / String(...)=='true'
  * CSS mit { und } nur auf getrennten Zeilen (eigenes Stil-Widget)
"""
import argparse
import copy
import json
import os
import sys

# ------------------------------------------------------------------ Farben/Schrift
BG = '#0E1726'
KARTE = '#16233A'
KARTE2 = '#1B2B47'
TEXT = '#E8EEF6'
LEISE = '#9FB0C6'
LINIE = '#2A3B57'
GRUEN = '#4CC38A'
ROT = '#E5484D'
SANS = "'IBM Plex Sans','Segoe UI',Roboto,Arial,sans-serif"
MONO = "'IBM Plex Mono','DejaVu Sans Mono',Consolas,monospace"

# Betriebsarten: Wert, Text, Farbe, Symbol
MODI = [
    ('heat_cool', 'Automatik', '#4CC38A', 'auto'),
    ('cool', 'Kühlen', '#4FB0E8', 'cool'),
    ('heat', 'Heizen', '#F0954B', 'heat'),
    ('dry', 'Trocknen', '#D9B44A', 'dry'),
    ('fan_only', 'Lüften', '#8FA3BA', 'fan'),
    ('off', 'Aus', '#6F8093', 'off'),
]
LUEFTER = [('auto', 'Auto'), ('night', 'Nacht'), ('low', '1'), ('lowMedium', '2'), ('medium', '3'),
           ('mediumHigh', '4'), ('high', '5')]
SCHWENKEN = [('off', 'aus'), ('on', 'an'), ('V', 'senkrecht'), ('H', 'waagerecht'), ('H+V', 'beide'),
             ('C', 'Komfort')]
PRESET = [('home', 'Normal'), ('eco', 'Eco'), ('boost', 'Boost')]

# Kleine Symbole (24er Raster, nur Attribute - keine geschweiften Klammern, kein Semikolon)
SVG = {
    'auto': '<path d="M4 12a8 8 0 0 1 14-5.3M20 12a8 8 0 0 1-14 5.3"/><path d="M18 3v4h-4M6 21v-4h4"/>',
    'cool': '<path d="M12 2v20M4.5 7l15 10M19.5 7l-15 10"/><path d="M9 4l3 2 3-2M9 20l3-2 3 2"/>',
    'heat': '<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/>',
    'dry': '<path d="M12 3c3.5 4.5 6 7.6 6 10.5a6 6 0 0 1-12 0C6 10.6 8.5 7.5 12 3z"/>',
    'fan': '<circle cx="12" cy="12" r="1.6"/><path d="M12 10.4c-1-3.4.2-6.4 2.6-6.4 2.2 0 2.6 3.2-2.6 6.4zM13.6 12c3.4-1 6.4.2 6.4 2.6 0 2.2-3.2 2.6-6.4-2.6zM12 13.6c1 3.4-.2 6.4-2.6 6.4-2.2 0-2.6-3.2 2.6-6.4zM10.4 12c-3.4 1-6.4-.2-6.4-2.6 0-2.2 3.2-2.6 6.4 2.6z"/>',
    'off': '<path d="M12 3v8"/><path d="M6.3 6.3a8 8 0 1 0 11.4 0"/>',
    'thermo': '<path d="M10 14.5V5a2 2 0 0 1 4 0v9.5a4 4 0 1 1-4 0z"/>',
    'aussen': '<path d="M3 20h18"/><path d="M5 20V10l7-5 7 5v10"/><path d="M10 20v-5h4v5"/>',
    'tropfen': '<path d="M12 3c3.5 4.5 6 7.6 6 10.5a6 6 0 0 1-12 0C6 10.6 8.5 7.5 12 3z"/>',
    'blitz': '<path d="M13 2L4 14h7l-1 8 9-12h-7z"/>',
    'verdichter': '<circle cx="12" cy="12" r="8"/><path d="M12 7v5l3 3"/>',
    'wlan': '<path d="M2 8.5a15 15 0 0 1 20 0M5 12a10 10 0 0 1 14 0M8.5 15.5a5 5 0 0 1 7 0"/><circle cx="12" cy="19" r="1"/>',
}


def svg(name, farbe, groesse=22):
    return ('<svg width="%d" height="%d" viewBox="0 0 24 24" fill="none" stroke="%s" stroke-width="1.8" '
            'stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">%s</svg>') % (groesse, groesse, farbe, SVG[name])


# ------------------------------------------------------------------ Bindungs-Helfer
def bind(vars_, formel):
    """vars_: [(name, oid)], formel ohne ; { }"""
    for z in ';{}':
        if z in formel:
            raise ValueError('verbotenes Zeichen %r in Formel: %s' % (z, formel))
    return '{' + ';'.join('%s:%s' % (n, o) for n, o in vars_) + ';' + formel + '}'


def zahl(oid, stellen=1, faktor=None):
    x = 'parseFloat(v)' if not faktor else '(parseFloat(v)*%s)' % faktor
    if stellen == 0:
        f = "(isNaN(parseFloat(v))?'–':Math.round(%s).toLocaleString('de-DE'))" % x
    else:
        f = "(isNaN(parseFloat(v))?'–':(%s).toFixed(%d).replace('.',','))" % (x, stellen)
    return bind([('v', oid)], f)


def tabelle(paare):
    """[('a','A'),...] -> JS-Literal [['a','A'],...] fuer .find()"""
    return '[' + ','.join("['%s','%s']" % (a, b) for a, b in paare) + ']'


def text_aus(oid, paare):
    return bind([('v', oid)], "(%s.find(x=>x[0]==v)||['',v=='null'||v=='undefined'?'–':v])[1]" % tabelle(paare))


def an(v):
    return "String(%s)=='true'" % v


# Farbe der Betriebsart (aus = grau), abhaengig von power UND mode
def modus_farbe(dev):
    paare = [(m, f) for m, _, f, _ in MODI]
    return bind([('p', dev + '.control.power'), ('m', dev + '.control.mode')],
                "%s?(%s.find(x=>x[0]==m)||['','%s'])[1]:'#6F8093'" % (an('p'), tabelle(paare), '#8FA3BA'))


def modus_text(dev):
    paare = [(m, t) for m, t, _, _ in MODI]
    return bind([('p', dev + '.control.power'), ('m', dev + '.control.mode')],
                "%s?(%s.find(x=>x[0]==m)||['',m])[1]:'Aus'" % (an('p'), tabelle(paare)))


def modus_symbol(dev):
    """Symbol als Bindung: liefert das komplette SVG der aktuellen Betriebsart."""
    paare = [(m, svg(s, f, 26).replace("'", '"')) for m, _, f, s in MODI]
    aus = svg('off', '#6F8093', 26).replace("'", '"')
    return bind([('p', dev + '.control.power'), ('m', dev + '.control.mode')],
                "%s?(%s.find(x=>x[0]==m)||['','%s'])[1]:'%s'" % (an('p'), tabelle(paare), aus, aus))


# ------------------------------------------------------------------ Widget-Huellen
DATA_GRUND = {
    "g_fixed": False, "g_visibility": False, "g_css_font_text": False, "g_css_background": False,
    "g_css_shadow_padding": False, "g_css_border": False, "g_gestures": False, "g_signals": False,
    "g_last_change": False, "visibility-cond": "==", "visibility-val": 1, "visibility-groups-action": "hide",
    "refreshInterval": "0", "lc-type": "last-change", "lc-is-interval": True, "lc-is-moment": False,
    "lc-format": "", "lc-position-vert": "top", "lc-position-horz": "right", "lc-offset-vert": 0,
    "lc-offset-horz": 0, "lc-font-size": "12px", "lc-font-family": "", "lc-font-style": "", "lc-bkg-color": "",
    "lc-color": "", "lc-border-width": "0", "lc-border-style": "", "lc-border-color": "", "lc-border-radius": 10,
    "lc-zindex": 0,
}


class Ansicht:
    def __init__(self, name, breite=1280, hoehe=800):
        self.name = name
        self.breite = breite
        self.hoehe = hoehe
        self.widgets = []  # (tpl, data, style, widgetSet)

    def html(self, x, y, w, h, inhalt, z=3):
        d = copy.deepcopy(DATA_GRUND)
        d['html'] = inhalt
        self.widgets.append(('tplHtml', d, {'left': '%dpx' % x, 'top': '%dpx' % y, 'width': '%dpx' % w,
                                            'height': '%dpx' % h, 'z-index': str(z)}, 'basic'))

    def faikout(self, tpl, x, y, w, h, daten, z=5):
        d = copy.deepcopy(DATA_GRUND)
        d.update(daten)
        self.widgets.append((tpl, d, {'left': '%dpx' % x, 'top': '%dpx' % y, 'width': '%dpx' % w,
                                      'height': '%dpx' % h, 'z-index': str(z)}, 'faikout'))

    def als_json(self, start_id):
        ws = {}
        n = start_id
        for tpl, d, st, ws_set in self.widgets:
            ws['w%05d' % n] = {'tpl': tpl, 'data': d, 'style': st, 'widgetSet': ws_set}
            n += 1
        return {
            'settings': {'style': {'background_class': '', 'background': BG}, 'theme': 'redmond',
                         'sizex': str(self.breite), 'sizey': str(self.hoehe), 'gridSize': '',
                         'useBackground': False, 'snapType': None},
            'widgets': ws,
            'name': self.name,
        }, n


# ------------------------------------------------------------------ Bausteine (HTML)
def karte(w, h, inhalt, pad=22, extra=''):
    return ('<div style="width:%dpx;height:%dpx;box-sizing:border-box;background:%s;border-radius:18px;'
            'padding:%dpx;color:%s;font-family:%s;overflow:hidden;%s">%s</div>') % (w, h, KARTE, pad, TEXT, SANS, extra, inhalt)


def etikett(t, gross=15):
    return '<div style="font-size:%dpx;color:%s">%s</div>' % (gross, LEISE, t)


def wert(inhalt, gross=28, farbe=TEXT, einheit=''):
    e = ('<span style="font-size:%dpx;color:%s;font-weight:400;margin-left:4px">%s</span>' % (max(13, gross // 2), LEISE, einheit)) if einheit else ''
    return '<div style="font-family:%s;font-size:%dpx;font-weight:600;color:%s;white-space:nowrap">%s%s</div>' % (MONO, gross, farbe, inhalt, e)


def zeile(links, rechts, gross=17, farbe=TEXT):
    return ('<div style="display:flex;justify-content:space-between;align-items:baseline;font-size:%dpx;color:%s;gap:12px">'
            '<span style="color:%s">%s</span><span style="font-family:%s;white-space:nowrap">%s</span></div>') % (gross, farbe, LEISE, links, MONO, rechts)


def trenner():
    return '<div style="height:1px;background:%s"></div>' % LINIE


def chip(inhalt, farbe=TEXT, rand=None):
    r = rand or LINIE
    return ('<span style="display:inline-flex;align-items:center;gap:6px;background:%s;border:1px solid %s;border-radius:999px;'
            'padding:5px 12px;font-size:15px;color:%s;white-space:nowrap">%s</span>') % (KARTE2, r, farbe, inhalt)


def kopf(titel, unterzeile, links, zurueck=None, breite=1216):
    knopf = ('<a href="#%s" style="height:44px;box-sizing:border-box;background:%s;border-radius:12px;padding:0 16px;'
             'text-decoration:none;color:%s;font-size:16px;font-family:%s;display:flex;align-items:center;white-space:nowrap;flex-shrink:0">%s</a>')
    z = (knopf % (zurueck[0], KARTE, TEXT, SANS, '‹ ' + zurueck[1])) if zurueck else ''
    nav = ''.join(knopf % (ziel, KARTE, TEXT, SANS, t + ' ›') for ziel, t in links)
    return ('<div style="width:%dpx;height:62px;display:flex;justify-content:space-between;align-items:center;font-family:%s;color:%s">'
            '<div style="display:flex;align-items:center;gap:16px">%s<div style="display:flex;flex-direction:column;gap:2px">'
            '<div style="font-size:28px;font-weight:600">%s</div><div style="font-size:15px;color:%s">%s</div></div></div>'
            '<div style="display:flex;gap:10px;align-items:center">%s</div></div>') % (breite, SANS, TEXT, z, titel, LEISE, unterzeile, nav)


def online_chip(dev):
    farbe = bind([('o', dev + '.info.online')], "%s?'%s':'%s'" % (an('o'), GRUEN, ROT))
    text = bind([('o', dev + '.info.online')], "%s?'verbunden':'offline'" % an('o'))
    return chip('<span style="width:9px;height:9px;border-radius:50%%;background:%s;display:inline-block"></span>%s' % (farbe, text), LEISE)


def zeit(oid):
    return bind([('t', oid)], "t=='null'||t==''||t=='undefined'?'–':new Date(t).toLocaleTimeString('de-DE').slice(0,5)")


def laufzeit(oid):
    return bind([('u', oid)], "isNaN(parseFloat(u))?'–':(Math.floor(u/86400)>0?Math.floor(u/86400)+' d ':'')+Math.floor(u%86400/3600)+' h'")


# Messkacheln: Schluessel -> (Feld, Titel, Symbol, Stellen, Einheit)
def kacheln(dev, felder, einheiten):
    k = {
        'outside': ('status.outside', 'Außen', 'aussen', 1, '°C'),
        'hum': ('status.hum', 'Luftfeuchte', 'tropfen', 0, '%'),
        'consumption': ('status.consumption', 'Leistung', 'blitz', 0, 'W'),
        'comp': ('status.comp', 'Verdichter', 'verdichter', 0, einheiten.get('status.comp', 'Hz')),
        'fanfreq': ('status.fanfreq', 'Lüfter', 'fan', 0 if einheiten.get('status.fanfreq', 'Hz') == 'rpm' else 1, einheiten.get('status.fanfreq', 'Hz')),
        'liquid': ('status.liquid', 'Kältemittel', 'thermo', 1, '°C'),
        'demand': ('control.demand', 'Begrenzung', 'blitz', 0, '%'),
    }
    reihe = ['outside', 'hum', 'consumption', 'comp', 'fanfreq', 'liquid', 'demand']
    gewaehlt = [s for s in reihe if felder is None or k[s][0] in felder]
    if felder is None:
        gewaehlt = reihe[:6]
    return [k[s] for s in gewaehlt[:6]]


def messgitter(dev, felder, einheiten, spalten=3, gross=24):
    teile = []
    for feld, titel, sym, stellen, einheit in kacheln(dev, felder, einheiten):
        teile.append('<div style="background:%s;border-radius:12px;padding:10px 12px;display:flex;flex-direction:column;gap:4px">'
                     '<div style="display:flex;align-items:center;gap:6px;font-size:14px;color:%s">%s%s</div>%s</div>'
                     % (KARTE2, LEISE, svg(sym, LEISE, 16), titel, wert(zahl(dev + '.' + feld, stellen), gross, TEXT, einheit)))
    return '<div style="display:grid;grid-template-columns:repeat(%d,minmax(0,1fr));gap:10px">%s</div>' % (spalten, ''.join(teile))


def geraete_karte(g, w, h, link=True, kompakt=False):
    """Uebersichtskarte eines Geraets (nur Anzeige)."""
    dev, name, felder, einh, ansicht = g['oid'], g['name'], g['felder'], g['einheiten'], g['ansicht']
    farbe = modus_farbe(dev)
    rand_oben = '<div style="height:4px;border-radius:4px;background:%s;margin:-2px 0 2px"></div>' % farbe
    titel = ('<div style="display:flex;justify-content:space-between;align-items:center;gap:10px">'
             '<div style="display:flex;align-items:center;gap:10px"><div style="font-size:24px;font-weight:600">%s</div></div>'
             '<div style="display:flex;gap:8px;align-items:center">%s%s</div></div>') % (
        name, online_chip(dev), ('<span style="font-size:22px;color:%s">›</span>' % LEISE) if link else '')
    gross_t = 58 if not kompakt else 46
    temps = ('<div style="display:flex;align-items:flex-end;justify-content:space-between;gap:12px">'
             '<div><div style="display:flex;align-items:center;gap:6px;font-size:15px;color:%s">%sRaum</div>%s</div>'
             '<div style="text-align:right"><div style="font-size:15px;color:%s">Soll</div>%s</div></div>') % (
        LEISE, svg('thermo', LEISE, 16), wert(zahl(dev + '.status.temp', 1), gross_t, TEXT, '°C'),
        LEISE, wert(zahl(dev + '.control.target', 1), 34 if not kompakt else 28, farbe, '°C'))
    modus = ('<div style="display:flex;flex-wrap:wrap;gap:8px;align-items:center">'
             '<span style="display:inline-flex;align-items:center;gap:8px;background:%s;border:1px solid %s;border-radius:999px;padding:4px 14px 4px 8px;font-size:17px;font-weight:600;color:%s">%s%s</span>'
             '%s%s%s</div>') % (
        KARTE2, farbe, farbe, modus_symbol(dev), modus_text(dev),
        chip('Lüfter ' + text_aus(dev + '.control.fan', LUEFTER), TEXT),
        chip('Lamellen ' + text_aus(dev + '.control.swing', SCHWENKEN), TEXT) if (felder is None or 'control.swing' in felder) else '',
        chip(text_aus(dev + '.control.preset', PRESET), TEXT) if (felder is None or 'control.preset' in felder) and not kompakt else '')
    energie = ('<div style="display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:10px">'
               '<div>%s%s</div><div>%s%s</div><div>%s%s</div></div>') % (
        etikett('Heute gesamt', 14), wert(zahl(dev + '.consumption.total.today', 1), 22, TEXT, 'kWh'),
        etikett('davon Heizen', 14), wert(zahl(dev + '.consumption.heating.today', 1), 22, '#F0954B', 'kWh'),
        etikett('davon Kühlen', 14), wert(zahl(dev + '.consumption.cooling.today', 1), 22, '#4FB0E8', 'kWh'))
    fuss = ('<div style="display:flex;justify-content:space-between;font-size:14px;color:%s;gap:10px">'
            '<span>Zähler %s kWh · Heizen %s · Kühlen %s</span><span>Meldung %s</span></div>') % (
        LEISE, zahl(dev + '.status.energy', 0), zahl(dev + '.status.energyheat', 0), zahl(dev + '.status.energycool', 0),
        zeit(dev + '.info.ts.val'))
    energie2 = ('<div style="display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:10px">'
                '<div>%s%s</div><div>%s%s</div><div>%s%s</div></div>') % (
        etikett('Gestern', 14), wert(zahl(dev + '.consumption.total.yesterday', 1), 22, TEXT, 'kWh'),
        etikett('Dieser Monat', 14), wert(zahl(dev + '.consumption.total.thisMonth', 1), 22, TEXT, 'kWh'),
        etikett('Letzter Monat', 14), wert(zahl(dev + '.consumption.total.lastMonth', 1), 22, TEXT, 'kWh'))
    wlan = ('<div style="display:flex;justify-content:space-between;font-size:14px;color:%s;gap:10px">'
            '<span style="display:flex;align-items:center;gap:6px">%sWLAN %s</span><span>Laufzeit %s</span></div>') % (
        LEISE, svg('wlan', LEISE, 15), bind([('v', dev + '.info.rssi')], "isNaN(parseFloat(v))?'–':v+' dBm'"), laufzeit(dev + '.info.uptime'))
    if kompakt:
        inhalt = '<div style="display:flex;flex-direction:column;gap:14px">%s</div>' % ''.join(
            [rand_oben, titel, temps, modus, messgitter(dev, felder, einh, 3, 19), energie])
    else:
        inhalt = '<div style="display:flex;flex-direction:column;gap:18px">%s</div>' % ''.join(
            [rand_oben, titel, temps, modus, messgitter(dev, felder, einh, 3, 24), trenner(), energie, energie2, trenner(), fuss, wlan])
    k = karte(w, h, inhalt)
    if link:
        k = '<a href="#%s" style="text-decoration:none;color:inherit;display:block">%s</a>' % (ansicht, k)
    return k


# ------------------------------------------------------------------ Ansichten
def ansicht_uebersicht(geraete, energie_ansicht, handy_ansicht):
    a = Ansicht('Faikout_Uebersicht')
    dev0 = geraete[0]['oid']
    unter = 'Außen %s °C · Klimaanlagen über faikout' % zahl(dev0 + '.status.outside', 1)
    links = [(g['ansicht'], g['name']) for g in geraete] + [(energie_ansicht, 'Energie'), (handy_ansicht, 'Handy')]
    a.html(32, 28, 1216, 62, kopf('Klima', unter, links))
    breite = (1216 - 16 * (len(geraete) - 1)) // len(geraete)
    for i, g in enumerate(geraete):
        a.html(32 + i * (breite + 16), 110, breite, 662, geraete_karte(g, breite, 662))
    return a


def ansicht_geraet(g, geraete, energie_ansicht):
    dev, name, felder, einh = g['oid'], g['name'], g['felder'], g['einheiten']
    a = Ansicht(g['ansicht'])
    unter = '%s · IP %s · Firmware %s' % (
        online_chip(dev).replace('font-size:15px', 'font-size:13px').replace('padding:5px 12px', 'padding:2px 10px'),
        bind([('v', dev + '.info.ipv4')], "v=='null'||v=='undefined'?'–':v"),
        bind([('v', dev + '.info.version')], "v=='null'||v=='undefined'?'–':v"))
    andere = [(x['ansicht'], x['name']) for x in geraete if x is not g]
    a.html(32, 28, 1216, 62, kopf(name, unter, andere + [(energie_ansicht, 'Energie')], zurueck=('Faikout_Uebersicht', 'Übersicht')))
    fk = {'deviceOid': dev, 'theme': 'dark', 'rahmen': False, 'titel': name}

    # Spalte 1: Sollwert (Bogen mit Ein/Aus) + Zusatzfunktionen
    a.html(32, 110, 393, 662, karte(393, 662, ''))
    a.faikout('tplFaikoutBogen', 42, 120, 373, 380, dict(fk, kopf=True, schalter=True, fuss=False, ziehen=True))
    a.html(52, 526, 353, 24, etikett('Zusatzfunktionen', 15), z=4)
    a.faikout('tplFaikoutZusatzH', 42, 552, 373, 120, dict(fk, kopf=False, schalter=False, fuss=False, etikett=False, beschriftung=True))
    a.html(52, 690, 353, 70, '<div style="font-size:13px;color:%s;line-height:1.45;font-family:%s">Bedienelemente schreiben auf die Datenpunkte unter <code style="color:%s">%s.control</code>. Die Anlage bestätigt in etwa einer Sekunde.</div>' % (LEISE, SANS, TEXT, dev), z=4)

    # Spalte 2: Betriebsart, Luefter, Temperaturen
    a.html(443, 110, 393, 286, karte(393, 286, ''))
    a.html(465, 128, 349, 24, etikett('Betriebsart', 16), z=4)
    a.faikout('tplFaikoutModusH', 453, 150, 373, 112, dict(fk, kopf=False, schalter=False, fuss=False, etikett=False, symbole=True))
    a.html(465, 268, 349, 24, etikett('Lüfter', 16), z=4)
    a.faikout('tplFaikoutLuefterH', 453, 290, 373, 120, dict(fk, kopf=False, schalter=False, fuss=False, etikett=False))
    temp = '<div style="display:flex;flex-direction:column;gap:12px">%s</div>' % ''.join([
        etikett('Temperaturen', 16),
        zeile('Raum (faikout)', zahl(dev + '.status.temp', 1) + ' °C'),
        zeile('Raum (Anlage)', zahl(dev + '.status.achome', 1) + ' °C'),
        zeile('Sollwert', zahl(dev + '.control.target', 1) + ' °C'),
        zeile('Sollwert der Anlage', zahl(dev + '.status.actarget', 1) + ' °C'),
        zeile('Außen', zahl(dev + '.status.outside', 1) + ' °C'),
        zeile('Kältemittel', zahl(dev + '.status.liquid', 1) + ' °C'),
        zeile('Luftfeuchte', zahl(dev + '.status.hum', 0) + ' %') if (felder is None or 'status.hum' in felder) else '',
    ])
    a.html(443, 412, 393, 360, karte(393, 360, temp))

    # Spalte 3: Betrieb, Energie, Verbindung
    cu, fu = einh.get('status.comp', 'Hz'), einh.get('status.fanfreq', 'Hz')
    betrieb = '<div style="display:flex;flex-direction:column;gap:12px">%s</div>' % ''.join([
        etikett('Betrieb jetzt', 16),
        '<div style="display:flex;align-items:baseline;gap:10px">%s</div>' % wert(zahl(dev + '.status.consumption', 0), 44, modus_farbe(dev), 'W'),
        zeile('Verdichter', zahl(dev + '.status.comp', 0) + ' ' + cu),
        zeile('Lüfter', zahl(dev + '.status.fanfreq', 0 if fu == 'rpm' else 1) + ' ' + fu),
        zeile('Leistungsgrenze', zahl(dev + '.control.demand', 0) + ' %') if (felder is None or 'control.demand' in felder) else '',
        zeile('Lamellen', text_aus(dev + '.control.swing', SCHWENKEN)) if (felder is None or 'control.swing' in felder) else '',
    ])
    a.html(854, 110, 393, 250, karte(393, 250, betrieb))
    en = '<div style="display:flex;flex-direction:column;gap:9px">%s</div>' % ''.join([
        etikett('Energie (kWh)', 16),
        '<div style="display:grid;grid-template-columns:1.3fr 1fr 1fr 1fr;gap:6px 8px;font-size:15px;align-items:baseline">' +
        ''.join('<span style="color:%s">%s</span>' % (LEISE, t) for t in ['', 'Gesamt', 'Heizen', 'Kühlen']) +
        ''.join(('<span style="color:%s">%s</span>' % (LEISE, t)) + ''.join(
            '<span style="font-family:%s;color:%s;text-align:right">%s</span>' % (MONO, c, zahl('%s.consumption.%s.%s' % (dev, art, per), 1))
            for art, c in [('total', TEXT), ('heating', '#F0954B'), ('cooling', '#4FB0E8')])
            for t, per in [('Heute', 'today'), ('Gestern', 'yesterday'), ('Dieser Monat', 'thisMonth'), ('Letzter Monat', 'lastMonth')]) +
        '</div>',
        trenner(),
        zeile('Zähler gesamt', zahl(dev + '.status.energy', 0) + ' kWh', 15),
        zeile('Heizen / Kühlen', zahl(dev + '.status.energyheat', 0) + ' / ' + zahl(dev + '.status.energycool', 0) + ' kWh', 15),
    ])
    a.html(854, 376, 393, 236, karte(393, 236, en, pad=20))
    verb = '<div style="display:flex;flex-direction:column;gap:8px">%s</div>' % ''.join([
        etikett('Verbindung', 15),
        zeile('WLAN', bind([('v', dev + '.info.rssi')], "isNaN(parseFloat(v))?'–':v+' dBm'") + ' · Kanal ' + zahl(dev + '.info.chan', 0), 15),
        zeile('Letzte Meldung · Laufzeit', zeit(dev + '.info.ts.val') + ' · ' + laufzeit(dev + '.info.uptime'), 15),
    ])
    a.html(854, 628, 393, 144, karte(393, 144, verb, pad=18))
    return a


def ansicht_energie(geraete):
    a = Ansicht('Faikout_Energie')
    a.html(32, 28, 1216, 62, kopf('Energie', 'Verbrauch je Anlage · Tag, Monat, Jahr umschaltbar',
                                  [(g['ansicht'], g['name']) for g in geraete], zurueck=('Faikout_Uebersicht', 'Übersicht')))
    breite = (1216 - 16 * (len(geraete) - 1)) // len(geraete)
    for i, g in enumerate(geraete):
        x = 32 + i * (breite + 16)
        dev = g['oid']
        a.html(x, 110, breite, 400, karte(breite, 400, '<div style="font-size:20px;font-weight:600">%s</div>' % g['name']))
        a.faikout('tplFaikoutVerlauf', x + 8, 150, breite - 16, 350, {
            'deviceOid': dev, 'theme': 'dark', 'rahmen': False, 'kopf': False, 'schalter': False, 'fuss': False,
            'range': 'month', 'rangeSwitch': True, 'seriesSelect': True, 'show_total': True, 'show_cooling': True, 'show_heating': True})
        zeilen = []
        for t, per in [('Diese Stunde', 'currentHour'), ('Letzte Stunde', 'lastHour'), ('Heute', 'today'), ('Gestern', 'yesterday'),
                       ('Dieser Monat', 'thisMonth'), ('Letzter Monat', 'lastMonth')]:
            zeilen.append(('<span style="color:%s">%s</span>' % (LEISE, t)) + ''.join(
                '<span style="font-family:%s;color:%s;text-align:right">%s</span>' % (MONO, c, zahl('%s.consumption.%s.%s' % (dev, art, per), 1))
                for art, c in [('total', TEXT), ('heating', '#F0954B'), ('cooling', '#4FB0E8')]))
        tab = ('<div style="display:grid;grid-template-columns:1.4fr 1fr 1fr 1fr;gap:7px 10px;font-size:16px;align-items:baseline">%s%s</div>' % (
            ''.join('<span style="color:%s">%s</span>' % (LEISE, t) for t in ['kWh', 'Gesamt', 'Heizen', 'Kühlen']), ''.join(zeilen)))
        zaehler = ('<div style="display:flex;justify-content:space-between;font-size:14px;color:%s;margin-top:12px">'
                   '<span>Zählerstand %s kWh</span><span>Heizen %s · Kühlen %s</span></div>') % (
            LEISE, zahl(dev + '.status.energy', 0), zahl(dev + '.status.energyheat', 0), zahl(dev + '.status.energycool', 0))
        a.html(x, 526, breite, 246, karte(breite, 246, tab + zaehler, pad=20))
    return a


def ansicht_handy(geraete, energie_ansicht):
    b = 412
    inner = b - 24
    a = Ansicht('Faikout_Handy', b, 100)
    y = 14
    a.html(12, y, inner, 56, ('<div style="display:flex;justify-content:space-between;align-items:center;font-family:%s;color:%s;width:%dpx">'
                              '<div style="font-size:26px;font-weight:600">Klima</div>'
                              '<a href="#%s" style="background:%s;border-radius:12px;padding:10px 14px;color:%s;text-decoration:none;font-size:15px">Energie ›</a></div>')
           % (SANS, TEXT, inner, energie_ansicht, KARTE, TEXT))
    y += 66
    for g in geraete:
        dev = g['oid']
        a.html(12, y, inner, 430, geraete_karte(g, inner, 430, link=False, kompakt=True))
        y += 442
        a.html(12, y, inner, 668, karte(inner, 668, ''))
        fk = {'deviceOid': dev, 'theme': 'dark', 'rahmen': False, 'titel': g['name']}
        a.faikout('tplFaikoutBogen', 16, y + 6, inner - 8, 360, dict(fk, kopf=True, schalter=True, fuss=False, ziehen=True))
        a.faikout('tplFaikoutModusH', 16, y + 372, inner - 8, 130, dict(fk, kopf=False, schalter=False, fuss=False, etikett=True, symbole=True))
        a.faikout('tplFaikoutLuefterH', 16, y + 508, inner - 8, 150, dict(fk, kopf=False, schalter=False, fuss=False, etikett=True))
        y += 682
    a.hoehe = y + 10
    return a


# ------------------------------------------------------------------ Ablauf
def bauen(geraete, start_id=1):
    energie, handy = 'Faikout_Energie', 'Faikout_Handy'
    ansichten = [ansicht_uebersicht(geraete, energie, handy)]
    ansichten += [ansicht_geraet(g, geraete, energie) for g in geraete]
    ansichten += [ansicht_energie(geraete), ansicht_handy(geraete, energie)]
    out = {}
    n = start_id
    for a in ansichten:
        j, n = a.als_json(n)
        out[a.name] = j
    return out


def pruefen(views):
    """Jede Bindung einzeln: keine verbotenen Zeichen, jede Zeile ohne verschachtelte Klammern."""
    import re
    fehler = 0
    for name, v in views.items():
        for wid, w in v['widgets'].items():
            h = w['data'].get('html', '')
            for zeile_ in h.split('\n'):
                tiefe = 0
                for ch in zeile_:
                    if ch == '{':
                        tiefe += 1
                        if tiefe > 1:
                            fehler += 1
                    elif ch == '}':
                        tiefe -= 1
                if tiefe != 0:
                    fehler += 1
    return fehler


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('modus', choices=['vorlage', 'anlage'])
    ap.add_argument('pfade', nargs='+')
    ap.add_argument('--geraet', action='append', default=[])
    ap.add_argument('--start-id', type=int, default=1)
    a = ap.parse_args()
    if a.modus == 'vorlage':
        ziel = a.pfade[0]
        geraete = [
            {'oid': 'faikout.0.DEVICE_1', 'name': 'Gerät 1', 'ansicht': 'Faikout_Geraet1', 'felder': None, 'einheiten': {}},
            {'oid': 'faikout.0.DEVICE_2', 'name': 'Gerät 2', 'ansicht': 'Faikout_Geraet2', 'felder': None, 'einheiten': {}},
        ]
        views = bauen(geraete)
        assert pruefen(views) == 0
        os.makedirs(ziel, exist_ok=True)
        for name, v in views.items():
            with open(os.path.join(ziel, 'view_%s.json' % name), 'w', encoding='utf-8') as f:
                json.dump(v, f, ensure_ascii=False, indent=1)
                f.write('\n')
        print('Vorlage:', ', '.join(views))
    else:
        objekte, ziel = a.pfade[0], a.pfade[1]
        d = json.load(open(objekte, encoding='utf-8'))
        geraete = []
        for spec in a.geraet:
            oid, name, ansicht = spec.split('=')
            felder = set()
            einh = {}
            for s in d['states']:
                if s['id'].startswith(oid + '.'):
                    f = s['id'][len(oid) + 1:]
                    felder.add(f)
                    if f in ('status.comp', 'status.fanfreq') and s.get('unit'):
                        einh[f] = s['unit']
            geraete.append({'oid': oid, 'name': name, 'ansicht': ansicht, 'felder': felder, 'einheiten': einh})
        views = bauen(geraete, a.start_id)
        assert pruefen(views) == 0
        with open(ziel, 'w', encoding='utf-8') as f:
            json.dump(views, f, ensure_ascii=False)
        print('Anlage:', ', '.join(views), '· Widgets', sum(len(v['widgets']) for v in views.values()))


if __name__ == '__main__':
    sys.exit(main())
