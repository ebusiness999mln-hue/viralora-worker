// Upload a buffer to a public Supabase Storage bucket and return its public URL.
async function uploadPublic(supabase, bucket, name, buf, contentType = 'application/octet-stream') {
  await supabase.storage.createBucket(bucket, { public: true }).catch(() => {}) // no-op if it exists
  const { error } = await supabase.storage.from(bucket).upload(name, buf, { contentType, upsert: true })
  if (error) throw error
  return supabase.storage.from(bucket).getPublicUrl(name).data.publicUrl
}

module.exports = { uploadPublic }
