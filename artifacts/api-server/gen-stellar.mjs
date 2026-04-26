import('@stellar/stellar-sdk').then(({Keypair})=>{
  const kp = Keypair.random();
  console.log('SEED='+kp.secret());
  console.log('PUBLIC='+kp.publicKey());
}).catch(e=>{ console.error(e); process.exit(1); });