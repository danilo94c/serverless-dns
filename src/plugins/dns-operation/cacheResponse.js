/*
 * Copyright (c) 2021 RethinkDNS and its authors.
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */
import { DnsBlocker } from "./dnsBlock.js";
import * as cacheutil from "../cacheutil.js";
import * as rdnsutil from "../dnsblockutil.js";
import * as dnsutil from "../../commons/dnsutil.js";
import * as util from "../../commons/util.js";

export class DNSCacheResponder {
  constructor(blocklistWrapper, cache) {
    this.blocker = new DnsBlocker();
    this.log = log.withTags("DnsCacheResponder");
    this.cache = cache;
    this.bw = blocklistWrapper;
  }

  /**
   * @param {*} param
   * @param {*} param.userBlocklistInfo
   * @param {*} param.requestDecodedDnsPacket
   * @param {*} param.isDnsMsg
   * @returns
   */
  async RethinkModule(param) {
    let response = util.emptyResponse();
    if (!param.isDnsMsg) {
      this.log.d(param.rxid, "not a dns-msg, nowt to resolve");
      return response;
    }

    try {
      response.data = await this.resolveFromCache(
        param.rxid,
        param.requestDecodedDnsPacket,
        param.userBlocklistInfo
      );
    } catch (e) {
      this.log.e(param.rxid, "main", e.stack);
      response = util.errResponse("DnsCacheHandler", e);
    }

    return response;
  }

  async resolveFromCache(rxid, packet, blockInfo) {
    const noAnswer = rdnsutil.rdnsNoBlockResponse();
    // if blocklist-filter is setup, then there's no need to query http-cache
    // (it introduces 5ms to 10ms latency). Because, the sole purpose of the
    // cache is to help avoid blocklist-filter downloads which cost 200ms
    // (when cached by cf) to 5s (uncached, downloaded from s3). Otherwise,
    // it only add 10s, even on cache-misses. This is expensive especially
    // when upstream DoHs (like cf, goog) have median response time of 10s.
    // When other platforms get http-cache / multiple caches (like on-disk),
    // the above reasoning may not apply, since it is only valid for infra
    // on Cloudflare, which not only has "free" egress, but also different
    // runtime (faster hw and sw) and deployment model (v8 isolates).
    const blf = this.bw.getBlocklistFilter();
    const onlyLocal =
      this.bw.disabled() || rdnsutil.isBlocklistFilterSetup(blf);

    const k = cacheutil.makeHttpCacheKey(packet);
    if (!k) return noAnswer;

    const cr = await this.cache.get(k, onlyLocal);
    this.log.d(rxid, "local?", onlyLocal, "cached ans", k.href, cr);

    if (util.emptyObj(cr)) return noAnswer;

    // note: stamps in cr may be out-of-date; for ex, consider a
    // scenario where v6.example.com AAAA to fda3:: today,
    // but CNAMEs to v6.test.example.org tomorrow. cr.metadata
    // would contain stamps for [v6.example.com, example.com]
    // whereas it should be [v6.example.com, example.com
    // v6.test.example.org, test.example.org, example.org]
    const stamps = rdnsutil.blockstampFromCache(cr);
    const res = rdnsutil.dnsResponse(cr.dnsPacket, cr.dnsBuffer, stamps);

    this.makeCacheResponse(rxid, /* out*/ res, blockInfo);

    if (res.isBlocked) return res;

    if (!cacheutil.isAnswerFresh(cr.metadata)) {
      this.log.d(rxid, "cache ans not fresh");
      return noAnswer;
    }

    cacheutil.updatedAnswer(
      /* out*/ res.dnsPacket,
      packet.id,
      cr.metadata.expiry
    );

    const reencoded = dnsutil.encode(res.dnsPacket);

    return rdnsutil.dnsResponse(res.dnsPacket, reencoded, res.stamps);
  }

  makeCacheResponse(rxid, r, blockInfo) {
    // check incoming dns request against blocklists in cache-metadata
    this.blocker.blockQuestion(rxid, /* out*/ r, blockInfo);
    this.log.d(rxid, blockInfo, "question blocked?", r.isBlocked);
    if (r.isBlocked) {
      return r;
    }

    // cache-response contains only query and not answers,
    // hence there are no more domains to block.
    if (!dnsutil.hasAnswers(r.dnsPacket)) {
      return r;
    }

    // check outgoing cached dns-packet against blocklists
    this.blocker.blockAnswer(rxid, /* out*/ r, blockInfo);
    this.log.d(rxid, "answer block?", r.isBlocked);

    return r;
  }
}
