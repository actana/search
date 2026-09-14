# Knowledge Base

A knowledge base gives an agent a long-term memory it can search. Documents are
uploaded or synced from a connector, split into chunks, embedded into vectors,
and stored so that a query can retrieve the passages that matter.

## Ingestion

An uploaded file is parsed into plain text and then chunked. The chunker is
chosen from the file extension: markdown uses a recursive splitter that prefers
heading boundaries, plain text uses a sliding window splitter, and structured
data such as JSON or YAML is split along the shape of the document so a chunk
is a coherent subtree rather than an arbitrary slice of characters.

Chunk size is expressed in tokens and defaults to one thousand and
twenty-four, with an overlap of one hundred and twenty-eight tokens carried
from the end of each chunk into the beginning of the next. Overlap is what
stops a sentence that straddles a boundary from being invisible to both
chunks.

Every chunk is embedded through the workspace's embedding endpoint. The
embedding call is batched by the provider's token and item limits, and the
vectors come back in input order. Chunks are written into a vector partition
dedicated to that knowledge base, indexed for approximate nearest neighbour
search.

## Keywords

After the chunks land, a second pass extracts a handful of tag-style keywords
per chunk using the workspace inference endpoint. Keywords are normalised to a
canonical lowercase form, deduplicated across the knowledge base, and stored
as a vocabulary with a usage count. A keyword is a single word or two words
joined by one hyphen — never a phrase.

The vocabulary is closed at query time. A search never invents new keywords; it
selects from the menu of keywords the knowledge base already has. That keeps
the keyword side of retrieval stable and explainable.

## Retrieval

A query is embedded with the same endpoint the documents used, then a
candidate set is over-fetched from the vector index by cosine distance. The
candidates are re-ranked by a blend of two scores: a semantic score from the
vector distance and a keyword score counting how many of the query's keywords
appear on the chunk. Both are normalised across the candidate set before they
are blended, because they live on incompatible scales.

The blend is tunable. A keyword weight of one is pure keyword matching, a
weight of zero is pure semantic similarity, and the default of one half sits
between them. A minimum score threshold trims weak matches after blending, and
the result set is finally cut to the requested number of matches.

## Clustering

Chunks are grouped into clusters by k-means over their vectors once the
knowledge base is large enough to make grouping meaningful. Clusters are
refitted when the corpus grows past a threshold, and the number of clusters is
chosen by a silhouette score across several candidate values.

For a small knowledge base, cluster routing is not applied to the read path:
the index is cheap to search whole, and pruning to the nearest clusters would
only risk losing a good match in a cluster the query did not land in. Routing
becomes an optimisation only for very large corpora.
