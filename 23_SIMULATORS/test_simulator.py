import unittest
from datetime import datetime,timezone,timedelta
from decimal import Decimal
from simulator import Sim,price,ring_volume,feed,ai_proposal,logistics

class TestSim(unittest.TestCase):
    def order(self):
        s=Sim();q=s.issue_quote();s.accept(q['hash']);return s,q
    def test_volume(self): self.assertAlmostEqual(ring_volume(18,4,1.8),447.8654487,places=4)
    def test_invalid_volume(self):
        with self.assertRaises(ValueError):ring_volume(0,4,1)
    def test_price(self): self.assertEqual(price(6,85,350,250),Decimal('1770.46'))
    def test_invalid_margin(self):
        with self.assertRaises(ValueError):price(6,85,350,250,margin=1)
    def test_reserve_unique(self):
        s,q=self.order();self.assertTrue(s.reserve('a'));self.assertFalse(s.reserve('b'));self.assertTrue(s.reserve('a'))
    def test_reservation_payload(self):
        s,q=self.order();s.reserve('a')
        with self.assertRaises(ValueError):s.reserve('a',qty=2)
    def test_duplicate_payment(self):
        s,q=self.order();s.payment('e',100);self.assertEqual(s.payment('e',100),Decimal(100))
    def test_wrong_currency(self):
        s,q=self.order()
        with self.assertRaises(ValueError):s.payment('e',100,'COP')
    def test_unverified_payment(self):
        s,q=self.order()
        with self.assertRaises(ValueError):s.payment('e',100,verified=False)
    def test_overpayment(self):
        s,q=self.order()
        with self.assertRaises(ValueError):s.payment('e',Decimal(q['total'])+1)
    def test_quote_expired(self):
        s=Sim();t=datetime.now(timezone.utc);q=s.issue_quote(t)
        with self.assertRaises(ValueError):s.accept(q['hash'],t+timedelta(hours=72))
    def test_accept_idempotent(self):
        s,q=self.order();self.assertEqual(s.accept(q['hash']),s.order)
    def test_approved_revision_immutable(self):
        s,q=self.order();base=s.revision;s.sync('op',base,{'width':5});self.assertEqual(s.order['revision'],base);self.assertEqual(s.revisions[base]['width'],4)
    def test_sync_conflict(self):
        s=Sim();base=s.revision;s.sync('op',base,{'width':5});self.assertEqual(s.sync('op2',base,{'width':6})['state'],'CONFLICT')
    def test_sync_duplicate(self):
        s=Sim();base=s.revision;a=s.sync('op',base,{'width':5});self.assertEqual(a,s.sync('op',base,{'width':5}))
    def test_sync_invalid(self):
        s=Sim()
        with self.assertRaises(ValueError):s.sync('op',s.revision,{'width':100})
    def test_release_gate(self):
        s,q=self.order();s.reserve('r')
        with self.assertRaises(ValueError):s.release(s.revision,True,True,True)
    def test_wrong_revision(self):
        s,q=self.order();s.reserve('r');s.payment('e',q['total']);s.sync('op',s.revision,{'width':5})
        with self.assertRaises(ValueError):s.release(s.revision,True,True,True)
    def test_certificate_gate(self):
        s,q=self.order()
        with self.assertRaises(ValueError):s.certificate()
    def test_end_to_end(self):
        s,q=self.order();s.reserve('r');s.payment('e',q['total']);self.assertTrue(s.release(s.revision,True,True,True));s.inspect([True,True]);self.assertTrue(s.certificate()['simulated'])
    def test_ai_determinism(self): self.assertEqual(ai_proposal('x','v'),ai_proposal('x','v'))
    def test_feed_outage(self):
        with self.assertRaises(RuntimeError):feed('outage')
    def test_logistics_delay(self): self.assertEqual(logistics('delay')['state'],'INCIDENT')
