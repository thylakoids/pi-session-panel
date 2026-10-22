# closed 分区在内存里建索引，永不实时扫描

`SessionManager.listAll()` 要读上千个 JSONL 的头部才能建出 `SessionInfo`，是几百毫秒级的操作。因此 closed 分区在面板打开时异步建一次内存索引，之后只读这个索引。

退出一个 Idle Session 时，不重扫，只往索引里插一条。这条记录需要的全部信息（路径、cwd、名字、时间）在退出那一刻都已经在手上了，插入是 O(1) 的。

## Consequences

用户按 X 关掉一个 Idle Session 后，它立刻出现在 Closed 分区，没有延迟。真正重扫只在手动按 `R` 时发生，且必须异步执行、不能阻塞渲染。
