import Foundation
import SlideKit

/// Average-linkage clustering of unit vectors on cosine similarity (`people.agglomerate`).
///
/// `clusters` are the existing people (indices into `emb`): they keep their members and never merge
/// with each other (that's the user's call). Every other face starts alone. Groups then merge, most
/// similar pair first, while the average similarity between their members is at least `threshold`
/// (for unit vectors: sum_a · sum_b / (n_a n_b)). `rejected[i]`: the existing clusters (by position)
/// face i was taken out of. `slides[i]`: the slide face i is on; two groups with a face on the same
/// slide never join. Answers the existing clusters (same order, maybe grown), then the new groups.
func agglomerate(_ emb: [[Float]], clusters: [[Int]], rejected: [Int: Set<Int>] = [:],
                 threshold: Double = Double(FaceRules.samePerson), slides: [String]? = nil) -> [[Int]] {
    let taken = Set(clusters.flatMap { $0 })
    var members = clusters + emb.indices.filter { !taken.contains($0) }.map { [$0] }
    let k = members.count, fixed = clusters.count
    guard k > 0 else { return [] }
    let dim = emb.first?.count ?? 128
    var S = members.map { m -> [Double] in
        var s = [Double](repeating: 0, count: dim)
        for i in m { for j in 0..<dim { s[j] += Double(emb[i][j]) } }
        return s
    }
    var n = members.map { Double($0.count) }
    var forbid = (0..<k).map { g in g < fixed ? Set<Int>() : (rejected[members[g][0]] ?? []) }
    if let slides {
        var there: [String: Set<Int>] = [:]
        for (g, m) in members.enumerated() { for i in m { there[slides[i], default: []].insert(g) } }
        for g in fixed..<k { forbid[g].formUnion(there[slides[members[g][0]]]!.subtracting([g])) }
    }
    var alive = n.map { $0 > 0 }
    var free = (0..<k).map { $0 >= fixed }
    var bestV = [Double](repeating: -.infinity, count: k)
    var bestC = [Int](repeating: 0, count: k)

    func sim(_ a: Int, _ b: Int) -> Double {
        var s = 0.0
        for j in 0..<dim { s += S[a][j] * S[b][j] }
        return s / (max(n[a], 1) * n[b])
    }
    func row(_ r: Int) {
        var bv = -Double.infinity, bc = 0
        for c in 0..<k where alive[c] && c != r && !forbid[r].contains(c) {
            let v = sim(c, r)
            if v > bv { bv = v; bc = c }
        }
        if bv == -.infinity { bc = (0..<k).first { $0 != r } ?? 0 }
        bestV[r] = bv; bestC[r] = bc
    }

    for r in fixed..<k { row(r) }
    while free.contains(true) {
        let rows = (0..<k).filter { free[$0] }
        let r = rows.max { bestV[$0] < bestV[$1] || (bestV[$0] == bestV[$1] && $0 > $1) }!   // first of the best, as argmax
        if bestV[r] < threshold { break }
        let c = bestC[r]
        let (keep, gone) = c < fixed ? (c, r) : (min(r, c), max(r, c))
        for j in 0..<dim { S[keep][j] += S[gone][j] }
        n[keep] += n[gone]
        members[keep] += members[gone]
        forbid[keep].formUnion(forbid[gone])
        alive[gone] = false; free[gone] = false
        n[gone] = 0
        // the other groups' similarity to the merged one changed; their best may have moved
        for rr in (0..<k).filter({ free[$0] }) {
            if forbid[rr].contains(gone) { forbid[rr].remove(gone); forbid[rr].insert(keep) }
            let v = (rr == keep || forbid[rr].contains(keep)) ? -Double.infinity : sim(rr, keep)
            if v > bestV[rr] { bestV[rr] = v; bestC[rr] = keep }
            else if bestC[rr] == keep || bestC[rr] == gone { row(rr) }
        }
        if free[keep] { row(keep) }
    }
    return Array(members[..<fixed]) + (fixed..<k).filter { alive[$0] }.map { members[$0] }
}

/// The library's people (`people.json`, shared with the desktop app): clusters of faces with an
/// optional name and birthday. Every edit is reload, apply, save, then `refresh` (as `people._edit`).
public final class People: @unchecked Sendable {
    public let files: FaceFiles
    /// A tray's slide ids in order, for "nearby" (names spread to slides up to `near` away).
    let order: @Sendable (String) -> [String]

    public init(files: FaceFiles, order: @escaping @Sendable (String) -> [String]) { self.files = files; self.order = order }

    // MARK: the file

    /// people.json: {"people": {pid: {"name", "faces", "birthday"?, "sure"?, "immich"?, "ignored"?}},
    /// "rejected": {face: [pids]}, "next", "ages_off"}.
    public struct File: Equatable {
        public var people: [String: [String: JSONValue]]
        public var rejected: [String: [String]]
        public var next: Int
        var agesOff: [String]
        var extra: [String: JSONValue]

        /// People in the order they were made (p1, p2, …), as Python keeps them.
        public var ids: [String] { people.keys.sorted { (Int($0.dropFirst()) ?? .max, $0) < (Int($1.dropFirst()) ?? .max, $1) } }
        public func faces(_ pid: String) -> [String] { people[pid]?["faces"]?.list?.compactMap(\.text) ?? [] }
        public func name(_ pid: String) -> String { people[pid]?["name"]?.text ?? "" }
        public func sure(_ pid: String) -> [String] { people[pid]?["sure"]?.list?.compactMap(\.text) ?? [] }
        public func ignored(_ pid: String?) -> Bool { pid.flatMap { people[$0]?["ignored"]?.flag } ?? false }
        /// Someone the user said who they are: a name or a birthday.
        public func known(_ pid: String?) -> Bool {
            guard let pid, let p = people[pid] else { return false }
            return !(p["name"]?.text ?? "").isEmpty || !(p["birthday"]?.text ?? "").isEmpty
        }
        /// Their name, or "Person 12" until they have one.
        public func label(_ pid: String) -> String { let n = name(pid); return n.isEmpty ? "Person \(pid.dropFirst())" : n }
        public func owner(of face: String) -> String? { ids.first { faces($0).contains(face) } }

        mutating func setFaces(_ pid: String, _ f: [String]) { people[pid]?["faces"] = .array(f.map { .string($0) }) }
        mutating func setSure(_ pid: String, _ f: [String]) { people[pid]?["sure"] = f.isEmpty ? nil : .array(f.map { .string($0) }) }
    }

    public func load() -> File {
        let d = files.lock.withLock { files.read(files.peopleURL) }
        var people: [String: [String: JSONValue]] = [:]
        for (pid, v) in d["people"]?.dict ?? [:] { if let o = v.dict { people[pid] = o } }
        var rejected: [String: [String]] = [:]
        for (f, v) in d["rejected"]?.dict ?? [:] { rejected[f] = v.list?.compactMap(\.text) ?? [] }
        var extra = d
        for k in ["people", "rejected", "next", "ages_off"] { extra[k] = nil }
        return File(people: people, rejected: rejected, next: Int(d["next"]?.number ?? 1),
                    agesOff: d["ages_off"]?.list?.compactMap(\.text) ?? [], extra: extra)
    }

    func save(_ f: File) throws {
        var o = f.extra
        o["people"] = .object(f.people.mapValues { .object($0) })
        o["rejected"] = .object(f.rejected.mapValues { .array($0.map { .string($0) }) })
        o["next"] = .int(f.next)
        o["ages_off"] = .array(f.agesOff.map { .string($0) })
        try files.lock.withLock { try files.write(files.peopleURL, o) }
    }

    // MARK: refresh

    /// Bring people.json up to date with the faces on disk (`people.refresh`): faces that are gone
    /// leave their person (an unnamed person left empty goes too), new faces join whoever they resemble
    /// or form new people; nobody on a slide twice; a face with someone it was taken out of leaves.
    @discardableResult
    public func refresh() throws -> File {
        try files.lock.withLock {
            let d = load()
            let faces = files.allFaces()
            let ids = faces.keys.sorted().filter { faces[$0]?.emb != nil }
            let index = Dictionary(uniqueKeysWithValues: ids.enumerated().map { ($1, $0) })
            let pids = d.ids
            let at = Dictionary(uniqueKeysWithValues: pids.enumerated().map { ($1, $0) })
            let emb = ids.map { faces[$0]!.emb! }
            let slides = ids.map { "\(faces[$0]!.tray)/\(faces[$0]!.slide)" }
            let own = Dictionary(uniqueKeysWithValues: pids.map { p in (p, d.faces(p).filter { !(d.rejected[$0] ?? []).contains(p) }) })
            let clusters = pids.map { onceASlide(own[$0]!, sure: Set(d.sure($0)), faces: faces, index: index, emb: emb) }
            var rejected: [Int: Set<Int>] = [:]
            for (f, ps) in d.rejected { if let i = index[f] { rejected[i] = Set(ps.compactMap { at[$0] }) } }
            let groups = agglomerate(emb, clusters: clusters, rejected: rejected, slides: slides)
            var new = d
            new.people = [:]
            for (p, g) in zip(pids, groups) {
                let blind = own[p]!.filter { faces[$0] != nil && index[$0] == nil }
                var person = d.people[p]!
                if !g.isEmpty || !blind.isEmpty || d.known(p) || person["immich"] != nil {
                    let fs = g.map { ids[$0] } + blind
                    person["faces"] = .array(fs.map { .string($0) })
                    if let sure = person["sure"]?.list?.compactMap(\.text) { person["sure"] = .array(sure.filter(fs.contains).map { .string($0) }) }
                    new.people[p] = person
                }
            }
            for g in groups.dropFirst(pids.count) {
                new.people["p\(new.next)"] = ["name": .string(""), "faces": .array(g.map { .string(ids[$0]) })]
                new.next += 1
            }
            new.rejected = d.rejected.filter { faces[$0.key] != nil }.mapValues { $0.filter { new.people[$0] != nil } }
            new.agesOff = d.agesOff.filter { faces[$0] != nil }
            if new != d { try save(new) }
            return new
        }
    }

    /// A person's described faces, one per slide (`people._once_a_slide`): of two or more on a slide
    /// the ones put with them by hand stay, else the one most like the rest; the others are
    /// clustered again (not rejected).
    func onceASlide(_ own: [String], sure: Set<String>, faces: [String: StoredFace], index: [String: Int], emb: [[Float]]) -> [Int] {
        var by: [String: [String]] = [:]
        for f in own { if let x = faces[f] { by["\(x.tray)/\(x.slide)", default: []].append(f) } }
        let members = own.compactMap { index[$0] }
        if by.values.allSatisfy({ $0.count == 1 }) { return members }
        var total = [Float](repeating: 0, count: emb.first?.count ?? 128)
        for i in members { for j in total.indices { total[j] += emb[i][j] } }
        var out = Set<String>()
        for fs in by.values {
            if fs.count == 1 { out.formUnion(fs) }
            else if fs.contains(where: sure.contains) { out.formUnion(fs.filter(sure.contains)) }
            else {
                let known = fs.filter { index[$0] != nil }
                if !known.isEmpty && members.count > known.count {
                    out.insert(known.max { a, b in
                        let ea = emb[index[a]!], eb = emb[index[b]!]
                        return dot(ea, zip(total, ea).map { $0 - $1 }) < dot(eb, zip(total, eb).map { $0 - $1 })
                    }!)
                } else { out.formUnion(fs) }
            }
        }
        return own.filter { index[$0] != nil && out.contains($0) }.map { index[$0]! }
    }

    // MARK: edits

    private func edit(_ fn: (inout File) throws -> Void) throws -> File {
        try files.lock.withLock {
            var d = load()
            try fn(&d)
            try save(d)
        }
        return try refresh()
    }

    private func merge(_ d: inout File, into: String, others: [String]) {
        guard var target = d.people[into] else { return }
        for p in others where p != into {
            guard let gone = d.people.removeValue(forKey: p) else { continue }
            let goneFaces = gone["faces"]?.list?.compactMap(\.text) ?? []
            target["faces"] = .array(((target["faces"]?.list?.compactMap(\.text) ?? []) + goneFaces).map { .string($0) })
            if let s = gone["sure"]?.list?.compactMap(\.text), !s.isEmpty {
                target["sure"] = .array(Set((target["sure"]?.list?.compactMap(\.text) ?? []) + s).sorted().map { .string($0) })
            }
            if (target["name"]?.text ?? "").isEmpty { target["name"] = gone["name"] ?? .string("") }
            if (target["birthday"]?.text ?? "").isEmpty, let b = gone["birthday"] { target["birthday"] = b }
            if target["immich"] == nil, let i = gone["immich"] { target["immich"] = i }
            if !(gone["ignored"]?.flag ?? false) { target["ignored"] = nil }   // ignored only if every one of them was
            for (f, ps) in d.rejected { d.rejected[f] = Set(ps.map { $0 == p ? into : $0 }).sorted() }
            for f in goneFaces where d.rejected[f]?.contains(into) ?? false {   // the user joined them
                d.rejected[f]!.removeAll { $0 == into }
                if d.rejected[f]!.isEmpty { d.rejected[f] = nil }
            }
        }
        d.people[into] = target
    }

    private func takeOut(_ d: inout File, _ pid: String, _ faces: [String]) {
        d.setFaces(pid, d.faces(pid).filter { !faces.contains($0) })
        if d.people[pid]?["sure"] != nil { d.setSure(pid, d.sure(pid).filter { !faces.contains($0) }) }
        for f in faces { d.rejected[f] = Set((d.rejected[f] ?? []) + [pid]).sorted() }
    }

    static func cleanName(_ s: String) -> String { String(s.split(whereSeparator: \.isWhitespace).joined(separator: " ").prefix(80)) }

    /// Name someone. A name another person has joins the two: it's the same person.
    @discardableResult
    public func rename(_ pid: String, _ name: String) throws -> File {
        let name = Self.cleanName(name)
        let d = try edit { d in
            guard d.people[pid] != nil else { throw FacesError.model("That person is gone") }
            d.people[pid]!["name"] = .string(name)
            if !name.isEmpty { d.people[pid]!["ignored"] = nil }
            if let same = d.ids.first(where: { $0 != pid && !name.isEmpty && d.name($0).lowercased() == name.lowercased() }) {
                merge(&d, into: same, others: [pid])
            }
        }
        return try spreadFrom(d, d.ids.filter { $0 == pid || (!name.isEmpty && d.name($0).lowercased() == name.lowercased()) })
    }

    /// Someone's birthday ("1952", "1952-03", "1952-03-14"); "" forgets it.
    @discardableResult
    public func setBirthday(_ pid: String, _ value: String) throws -> File {
        let v = value.trimmingCharacters(in: .whitespaces)
        var clean = ""
        if !v.isEmpty {
            guard let (date, precision) = SlideDates.parse(v), (1850...2100).contains(Calendar(identifier: .gregorian).component(.year, from: date)) else {
                throw FacesError.model("A birthday is a year, year-month or a full date, like 1952-03-14")
            }
            clean = SlideDates.format(date, precision: precision)
        }
        let d = try edit { d in
            guard d.people[pid] != nil else { throw FacesError.model("That person is gone") }
            d.people[pid]!["birthday"] = clean.isEmpty ? nil : .string(clean)
        }
        return try spreadFrom(d, [pid])
    }

    @discardableResult
    public func merge(into: String, _ others: [String]) throws -> File {
        let d = try edit { d in
            guard d.people[into] != nil else { throw FacesError.model("That person is gone") }
            merge(&d, into: into, others: others)
        }
        return try spreadFrom(d, [into])
    }

    /// Take wrongly grouped faces out of someone; they won't be put back there.
    @discardableResult
    public func remove(_ pid: String, faces: [String]) throws -> File {
        try edit { d in
            guard d.people[pid] != nil else { throw FacesError.model("That person is gone") }
            takeOut(&d, pid, faces)
        }
    }

    public enum Target: Equatable { case person(String), new(String), nobody }

    /// Say who a face is (`people.assign`): someone, someone new (a name someone has is them), or
    /// nobody in particular. Whoever it was with is remembered as not it; the face is `sure` with its
    /// new person. Naming a face of an unnamed group brings the rest of the group that looks like it.
    @discardableResult
    public func assign(_ face: String, to: Target) throws -> File {
        let d = try edit { d in
            let now = d.owner(of: face)
            var target: String?
            switch to {
            case .nobody: target = nil
            case .person(let p):
                guard d.people[p] != nil else { throw FacesError.model("That person is gone") }
                target = p
            case .new(let raw):
                let name = Self.cleanName(raw)
                target = d.ids.first { !name.isEmpty && d.name($0).lowercased() == name.lowercased() }
                if target == nil {
                    target = "p\(d.next)"
                    d.next += 1
                    d.people[target!] = ["name": .string(name), "faces": .array([])]
                }
            }
            if let now, now != target { takeOut(&d, now, [face]) }
            d.agesOff.removeAll { $0 == face }
            guard let target else { return }
            d.people[target]!["ignored"] = nil   // put with them by hand: they matter
            if !d.faces(target).contains(face) { d.setFaces(target, d.faces(target) + [face]) }
            d.setSure(target, Set(d.sure(target) + [face]).sorted())
            let rej = (d.rejected[face] ?? []).filter { $0 != target }
            d.rejected[face] = rej.isEmpty ? nil : rej
            if let now, now != target, d.known(target), !d.known(now), d.people[now]?["immich"] == nil {
                follow(&d, face: face, from: now, to: target)
            }
        }
        let tray = String(face.split(separator: "/").first ?? "")
        return try spreadFrom(d, d.ids.filter { d.faces($0).contains(face) }, trays: [tray])
    }

    /// The rest of an unnamed group that looks like a face just named comes along (`_follow`).
    private func follow(_ d: inout File, face: String, from: String, to: String) {
        let faces = files.allFaces()
        guard let me = faces[face], let e = me.emb else { return }
        var on = Set(d.faces(to).compactMap { faces[$0].map { "\($0.tray)/\($0.slide)" } })
        for f in d.faces(from) {
            guard let x = faces[f], let xe = x.emb, !(d.rejected[f] ?? []).contains(to),
                  !on.contains("\(x.tray)/\(x.slide)"), dot(xe, e) >= FaceRules.samePerson else { continue }
            d.setFaces(from, d.faces(from).filter { $0 != f })
            d.setFaces(to, d.faces(to) + [f])
            on.insert("\(x.tray)/\(x.slide)")
        }
    }

    /// Ignore people (strangers in a crowd) or stop ignoring them.
    @discardableResult
    public func setIgnored(_ pids: [String], _ ignored: Bool) throws -> File {
        try edit { d in
            for p in pids where d.people[p] != nil { d.people[p]!["ignored"] = ignored ? .bool(true) : nil }
        }
    }

    // MARK: names spread

    /// How sure it is that face x is whoever face y is, on slides close together (`_fit`).
    static func fit(_ x: StoredFace, _ y: StoredFace) -> Float? {
        let look: Float? = (x.emb != nil && y.emb != nil) ? dot(x.emb!, y.emb!) : nil
        let dress = Clothes.like(x.clothes, y.clothes)
        if let look, look >= FaceRules.samePerson { return look + (dress ?? 0) }
        if let dress, look == nil ? dress >= FaceRules.clothesOnly : (dress >= FaceRules.sameClothes && look! >= FaceRules.looksLike) {
            return (look ?? 0) + dress
        }
        return nil
    }

    /// Names spread to the slides around them (`people.spread`). Answers the faces named.
    @discardableResult
    public func spread(trays: [String]) throws -> [String] {
        guard load().ids.contains(where: load().known) else { return [] }
        return try files.lock.withLock {
            var d = try refresh()
            let faces = files.allFaces()
            var owner: [String: String] = [:]
            for p in d.ids { for f in d.faces(p) { owner[f] = p } }
            let sure = Set(d.ids.flatMap { d.sure($0) })
            var moved: [String] = []
            var seenTrays = Set<String>()
            for tray in trays where seenTrays.insert(tray).inserted {
                let ord = order(tray)
                let pos = Dictionary(uniqueKeysWithValues: ord.enumerated().map { ($1, $0) })
                let here = faces.filter { $0.value.tray == tray && pos[$0.value.slide] != nil }
                var pairs: [(Float, String, String)] = []
                for (f, x) in here where !sure.contains(f) && x.emb != nil {
                    for (a, y) in here {
                        let dist = abs(pos[x.slide]! - pos[y.slide]!)
                        if dist > 0 && dist <= FaceRules.near, let v = Self.fit(x, y) { pairs.append((v, f, a)) }
                    }
                }
                pairs.sort { $0.0 > $1.0 }
                var on = Set(here.map { "\(owner[$0.key] ?? "")|\($0.value.slide)" })
                var changed = true
                while changed {
                    changed = false
                    for (_, f, a) in pairs {
                        let p = owner[a], now = owner[f]
                        guard let p, d.known(p), !d.known(now), p != now, !(d.rejected[f] ?? []).contains(p),
                              !on.contains("\(p)|\(here[f]!.slide)"), !d.ignored(p), !d.ignored(now) else { continue }
                        if let now { d.setFaces(now, d.faces(now).filter { $0 != f }) }
                        d.setFaces(p, d.faces(p) + [f])
                        owner[f] = p
                        on.insert("\(p)|\(here[f]!.slide)")
                        moved.append(f)
                        changed = true
                    }
                }
            }
            if !moved.isEmpty {
                try save(d)
                try refresh()
            }
            return moved
        }
    }

    private func spreadFrom(_ d: File, _ pids: [String], trays: [String] = []) throws -> File {
        let faces = files.allFaces()
        let ts = trays + Set(pids.flatMap { d.faces($0) }.compactMap { faces[$0]?.tray }).sorted()
        return try !ts.isEmpty && !spread(trays: ts).isEmpty ? refresh() : d
    }

    /// How likely a face is each person the user named (`people.likely`): the mean of its three best
    /// matches among their faces, plus up to 0.5 when they're on slides around it (most on the next
    /// one, most in the same clothes); -1 when they're on its slide already or it was taken out of
    /// them. `FaceRules.samePerson` and up is likely them.
    public func likely(_ face: String, _ d: File) -> [String: Double] {
        let faces = files.allFaces()
        guard let me = faces[face] else { return [:] }
        let ord = order(me.tray)
        let pos = Dictionary(uniqueKeysWithValues: ord.enumerated().map { ($1, $0) })
        let here = pos[me.slide]
        var out: [String: Double] = [:]
        for pid in d.ids where d.known(pid) {
            let fs = d.faces(pid).filter { $0 != face }.compactMap { faces[$0] }
            if (d.rejected[face] ?? []).contains(pid) || fs.contains(where: { $0.tray == me.tray && $0.slide == me.slide }) {
                out[pid] = -1; continue
            }
            let sims = fs.compactMap { x -> Float? in (me.emb != nil && x.emb != nil) ? dot(me.emb!, x.emb!) : nil }.sorted(by: >)
            var near = 0.0
            for x in fs {
                let dist = (x.tray == me.tray && pos[x.slide] != nil && here != nil) ? abs(pos[x.slide]! - here!) : 0
                if dist > 0 && dist <= FaceRules.near {
                    let dress = Double(Clothes.like(me.clothes, x.clothes) ?? 0)
                    near = max(near, (1 - Double(dist - 1) / Double(FaceRules.near)) * (0.1 + 0.4 * dress))
                }
            }
            let look = sims.isEmpty ? 0 : Double(sims.prefix(3).reduce(0, +)) / Double(min(3, sims.count))
            out[pid] = rounded(look + near, 4)
        }
        return out
    }
}
