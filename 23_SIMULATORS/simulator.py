"""Deterministic offline engineering reference. No external calls, no real payments."""
from decimal import Decimal, ROUND_HALF_UP
from datetime import datetime, timezone, timedelta
import sqlite3, hashlib, json, math
D=Decimal

def digest(x): return hashlib.sha256(json.dumps(x,sort_keys=True,separators=(',',':')).encode()).hexdigest()
def ring_volume(d,w,t):
    if not all(math.isfinite(x) and x>0 for x in (d,w,t)): raise ValueError('invalid geometry')
    return math.pi*((d/2+t)**2-(d/2)**2)*w

def price(grams,rate,gem,labor,allowance='0.08',margin='0.35'):
    g,r,s,l,a,m=map(lambda x:D(str(x)),(grams,rate,gem,labor,allowance,margin))
    if min(g,r,s,l,a,m)<0 or m>=1: raise ValueError('invalid price')
    cost=g*r*(1+a)+s+l
    return (cost/(1-m)).quantize(D('0.01'),rounding=ROUND_HALF_UP)

def ai_proposal(prompt, revision):
    return {'simulated':True,'baseRevision':revision,'concepts':[{'name':'Classic','description':'Aro y gema central'},{'name':'Halo','description':'Montura halo'},{'name':'Minimal','description':'Aro sencillo'}], 'inputHash':digest(prompt)}
def feed(scenario='normal'):
    if scenario=='outage': raise RuntimeError('provider unavailable; use stale reference only')
    return {'simulated':True,'metalUsdPerGram':'85' if scenario=='normal' else '95','fxCopPerUsd':'4000','snapshot':'demo-001'}
def logistics(scenario='normal'):
    return {'simulated':True,'state':{'normal':'DELIVERED','delay':'INCIDENT','transit':'DISPATCHED'}[scenario]}

class Sim:
    def __init__(self):
        self.db=sqlite3.connect(':memory:')
        self.db.executescript('CREATE TABLE stock(id TEXT PRIMARY KEY, available INTEGER CHECK(available>=0)); CREATE TABLE reservation(key TEXT PRIMARY KEY, item TEXT, qty INTEGER); CREATE TABLE webhook(id TEXT PRIMARY KEY, amount TEXT, currency TEXT); INSERT INTO stock VALUES ("gem-1",1);')
        self.document={'family':'ring.classic','diameter':18,'width':4,'thickness':1.8}
        self.revision=digest(self.document); self.revisions={self.revision:dict(self.document)};self.sync_ops={}; self.quote=None;self.order=None;self.paid=D(0);self.released=False;self.qa=False
    def sync(self, op_id, base, changes):
        fingerprint=digest([base,changes])
        if op_id in self.sync_ops:
            oldfp,result=self.sync_ops[op_id]
            if fingerprint!=oldfp: raise ValueError('idempotency mismatch')
            return result
        if base!=self.revision: result={'state':'CONFLICT','head':self.revision}
        else:
            if set(changes)-{'diameter','width','thickness'}: raise ValueError('unknown parameter')
            draft={**self.document,**changes};ring_volume(draft['diameter'],draft['width'],draft['thickness'])
            if not 14<=draft['diameter']<=24 or not 1.5<=draft['width']<=12 or not .8<=draft['thickness']<=4: raise ValueError('out of range')
            self.document=draft;self.revision=digest(draft);self.revisions[self.revision]=dict(draft);result={'state':'APPLIED','head':self.revision}
        self.sync_ops[op_id]=(fingerprint,result);return result
    def issue_quote(self, now=None):
        if self.order: raise ValueError('new quote requires new agreement after acceptance')
        now=now or datetime.now(timezone.utc)
        p=price('6','85','350','250')
        self.quote={'revision':self.revision,'total':str(p),'currency':'USD','expires':(now+timedelta(hours=72)).isoformat(),'state':'ISSUED'};self.quote['hash']=digest(self.quote);return dict(self.quote)
    def accept(self, expected_hash, now=None):
        if self.order:
            if self.order['quoteHash']==expected_hash:return dict(self.order)
            raise ValueError('different quote')
        q=self.quote;now=now or datetime.now(timezone.utc)
        if not q or q['hash']!=expected_hash or now>=datetime.fromisoformat(q['expires']):raise ValueError('quote invalid or expired')
        q['state']='ACCEPTED';self.order={'id':'order-demo','quoteHash':expected_hash,'revision':q['revision'],'total':q['total'],'currency':q['currency']};return dict(self.order)
    def reserve(self,key,item='gem-1',qty=1):
        if not self.order or not isinstance(qty,int) or qty<1:raise ValueError('invalid reservation')
        with self.db:
            existing=self.db.execute('SELECT item,qty FROM reservation WHERE key=?',(key,)).fetchone()
            if existing:
                if existing!=(item,qty):raise ValueError('idempotency mismatch')
                return True
            cur=self.db.execute('UPDATE stock SET available=available-? WHERE id=? AND available>=?',(qty,item,qty))
            if cur.rowcount!=1:return False
            self.db.execute('INSERT INTO reservation VALUES (?,?,?)',(key,item,qty));return True
    def payment(self,event_id,amount,currency='USD',verified=True):
        if not self.order or not verified or currency!=self.order['currency']:raise ValueError('payment verification')
        a=D(str(amount))
        if a<=0:raise ValueError('invalid amount')
        with self.db:
            old=self.db.execute('SELECT amount,currency FROM webhook WHERE id=?',(event_id,)).fetchone()
            if old:
                if D(old[0])!=a or old[1]!=currency:raise ValueError('webhook mismatch')
                return self.paid
            if self.paid+a>D(self.order['total']):raise ValueError('overpayment review')
            self.db.execute('INSERT INTO webhook VALUES (?,?,?)',(event_id,str(a),currency));self.paid+=a;return self.paid
    def release(self,revision,dfm,approved,size_confirmed):
        if not self.order or revision!=self.order['revision'] or not all((dfm,approved,size_confirmed)) or self.paid < (D(self.order['total'])/2).quantize(D('.01'),rounding=ROUND_HALF_UP) or not self.db.execute('SELECT 1 FROM reservation').fetchone():raise ValueError('release gate failed')
        self.released=True;return True
    def inspect(self,checks):
        if not self.released or not checks or not all(checks):raise ValueError('QA failed')
        self.qa=True
    def certificate(self):
        if not self.qa:raise ValueError('QA required')
        return {'id':'CERT-DEMO-01','simulated':True,'revision':self.order['revision']}

if __name__=='__main__':
    s=Sim(); print('SIMULATION ONLY');print(ai_proposal('Anillo esmeralda',s.revision));q=s.issue_quote();print(q);print(s.accept(q['hash']));assert s.reserve('r1');s.payment('evt1',D(q['total']));s.release(s.revision,True,True,True);s.inspect([True,True]);print(s.certificate())
